import { LitElement, html, css } from 'https://unpkg.com/lit@2.7.5/index.js?module';
import ApexCharts from '/local/community/ladecharts-card/libs/apexcharts.esm.js';

class LadechartsCard extends LitElement {
  static properties = {
    viewMode: { type: String },
    startDate: { type: Object }
  };

  constructor() {
    super();
    this.viewMode = 'week';
    this.startDate = this.getPeriodStartDate(new Date());
  }

  setConfig(config) {
    this.config = config;
  }

  // Chart bei Initialisierung rendern
  firstUpdated() {
    this._renderChart();
  }

  // Chart bei Änderung von View oder Startdatum aktualisieren
  updated(changedProps) {
    if (changedProps.has('viewMode') || changedProps.has('startDate')) {
      this._renderChart();
    }
  }

  // Hilfsfunktion: Startdatum für Zeiträume berechnen
  getPeriodStartDate(date) {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    switch (this.viewMode) {
      case 'week':
        const diff = date.getDay() === 0 ? -6 : 1 - date.getDay();
        result.setDate(date.getDate() + diff);
        break;
      case 'month':
        result.setDate(1);
        break;
      case 'year':
        result.setMonth(0, 1);
        break;
    }
    return new Date(result.getTime() - result.getTimezoneOffset() * 60000);
  }

  // Hilfsfunktion: Enddatum für Zeitraum
  getPeriodEndDate(start, viewMode) {
    const end = new Date(start);
    switch (viewMode) {
      case 'day': end.setDate(end.getDate() + 1); break;
      case 'week': end.setDate(end.getDate() + 7); break;
      case 'month': end.setMonth(end.getMonth() + 1); break;
      case 'year': end.setFullYear(end.getFullYear() + 1); break;
    }
    return end;
  }

  // Hauptfunktion zum Rendern beider Diagramme
  async _renderChart() {
    const chartEl = this.renderRoot.querySelector("#chart");
    const pieEl = this.renderRoot.querySelector("#piechart");

    const start = this.startDate;
    const end = this.getPeriodEndDate(start, this.viewMode);
    const windowSize = this.viewMode === 'year' ? '1mo' : '1d';

    const flux = `
      import "join"
      base = from(bucket: "Wallbox")
        |> range(start: ${start.toISOString()}, stop: ${end.toISOString()})
        |> filter(fn: (r) => r["_measurement"] == "Ladezyklen")
        |> filter(fn: (r) =>
          r["_field"] == "Ladung (kWh)" or
          r["_field"] == "PV Strom (kWh)")
        |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> map(fn: (r) => ({
          _time: r._time,
          "Strom (kWh)": r["Ladung (kWh)"] - r["PV Strom (kWh)"],
          "PV Strom (kWh)": r["PV Strom (kWh)"]
        }))

      pv = base
        |> keep(columns: ["_time", "PV Strom (kWh)"])
        |> aggregateWindow(every: ${windowSize}, fn: sum, column: "PV Strom (kWh)", createEmpty: true, timeSrc: "_start")
        |> rename(columns: { "PV Strom (kWh)": "sum_pv" })

      strom = base
        |> keep(columns: ["_time", "Strom (kWh)"])
        |> aggregateWindow(every: ${windowSize}, fn: sum, column: "Strom (kWh)", createEmpty: true, timeSrc: "_start")
        |> rename(columns: { "Strom (kWh)": "sum_strom" })

      joined = join.inner(
        left: pv,
        right: strom,
        on: (l, r) => l._time == r._time,
        as: (l, r) => ({ l with sum_strom: r.sum_strom })
      )

      joined
        |> drop(columns: ["_start", "_stop"])
        |> map(fn: (r) => ({
          _time: r._time,
          "Strom (kWh)": if exists r.sum_strom then r.sum_strom else 0.0,
          "PV Strom (kWh)": if exists r.sum_pv then r.sum_pv else 0.0
        }))
    `;

    // Daten abrufen
    const response = await fetch('http://192.168.178.2:8086/api/v2/query?orgID=<yourorgid>', {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Authorization': 'Token <yourtoken>',
        'Accept': 'application/csv',
        'Content-type': 'application/vnd.flux'
      },
      body: flux
    });

    const csv = await response.text();
    const lines = csv.trim().split('\n');
    const headers = lines[0].split(',');
    const timeIndex = headers.findIndex(h => h.startsWith("_time"));
    const stromIndex = headers.findIndex(h => h.startsWith("Strom (kWh)"));
    const pvIndex = headers.findIndex(h => h.startsWith("PV Strom (kWh)"));

    const formatDateLocal = (iso) =>
      new Intl.DateTimeFormat('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

    const data = lines.slice(1).map(line => {
      const parts = line.split(',');
      return {
        date: formatDateLocal(parts[timeIndex]),
        strom: parseFloat(parts[stromIndex] || '0'),
        pvstrom: parseFloat(parts[pvIndex] || '0')
      };
    });

    const categories = data.map(d => d.date);
    const netzstrom = data.map(d => +d.strom.toFixed(2));
    const pvstrom = data.map(d => +d.pvstrom.toFixed(2));

    // Balkendiagramm
    const options = {
      chart: { type: 'bar', height: 300, stacked: true },
      fill: { opacity: 1 },
      dataLabels: { enabled: false },
      tooltip: {
        theme: 'dark',
        y: { formatter: val => val.toFixed(2) + ' kWh' }
      },
      legend: { labels: { colors: '#ffffff' } },
      series: [
        { name: 'Netzstrom', data: netzstrom, color: '#03a8f4' },
        { name: 'PV Strom', data: pvstrom, color: '#f4c542' }
      ],
      xaxis: {
        categories,
        type: 'category',
        tickAmount: Math.ceil(categories.length / 2),
        labels: {
          rotate: -45,
          rotateAlways: true,
          style: { colors: '#ffffff', fontSize: '12px' },
          formatter: (val) => this.viewMode === 'year' ? val.substring(3, 10) : val
        }
      },
      yaxis: {
        labels: {
          style: { colors: '#ffffff', fontSize: '12px' },
          formatter: (val) => val.toFixed(0)
        },
        title: {
          text: 'kWh',
          style: { color: '#ffffff', fontSize: '14px', fontWeight: 600 }
        }
      }
    };

    if (this._chart) {
      this._chart.updateOptions(options);
    } else {
      this._chart = new ApexCharts(chartEl, options);
      this._chart.render();
    }

    // Kreisdiagramm
    const pieOptions = {
      chart: { type: 'pie', height: 300 },
      labels: ['Netzstrom', 'PV Strom'],
      series: [
        netzstrom.reduce((sum, v) => sum + v, 0),
        pvstrom.reduce((sum, v) => sum + v, 0)
      ],
      colors: ['#03a8f4', '#f4c542'],
      legend: { show: false },
      tooltip: {
        y: { formatter: val => val.toFixed(2) + ' kWh' }
      }
    };

    if (this._pieChart) {
      this._pieChart.updateSeries(pieOptions.series);
    } else {
      this._pieChart = new ApexCharts(pieEl, pieOptions);
      this._pieChart.render();
    }
  }

  // Anzeige-Label für aktuelle Periode
  _getDisplayLabel() {
    const d = this.startDate;
    const locale = navigator.language || 'de-DE';
    switch (this.viewMode) {
      case 'week':
        const start = new Date(d);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        return `${start.toLocaleDateString(locale)} - ${end.toLocaleDateString(locale)}`;
      case 'month':
        return d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
      case 'year':
        return d.getFullYear();
      default:
        return '';
    }
  }

  _onViewChange(e) {
    this.viewMode = e.target.value;
    this.startDate = this.getPeriodStartDate(this.startDate);
  }

  _shiftOffset(delta) {
    const d = new Date(this.startDate);
    switch (this.viewMode) {
      case 'week': d.setDate(d.getDate() + delta * 7); break;
      case 'month': d.setMonth(d.getMonth() + delta); break;
      case 'year': d.setFullYear(d.getFullYear() + delta); break;
    }
    this.startDate = this.getPeriodStartDate(d);
  }

  static styles = css`
    .controls {
      display: flex;
      flex-direction: column;
      padding: 16px;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .title {
      font-size: 16px;
      font-weight: bold;
      text-align: center;
      flex-grow: 1;
    }
    .nav-buttons {
      display: flex;
      align-items: center;
    }
    .container {
      padding: 8px;
    }
  `;

  render() {
    return html`
      <ha-card .header=${this.config.title}>
        <div class="controls">
          <div class="header-row">
            <div class="nav-buttons">
              <ha-icon-button @click=${() => this._shiftOffset(-1)}>
                <ha-icon icon="mdi:chevron-left"></ha-icon>
              </ha-icon-button>
              <ha-icon-button @click=${() => this._shiftOffset(1)}>
                <ha-icon icon="mdi:chevron-right"></ha-icon>
              </ha-icon-button>
            </div>
            <div class="title">${this._getDisplayLabel()}</div>
            <ha-select @change=${this._onViewChange} value=${this.viewMode} style="width:110px">
              <mwc-list-item value="week">Woche</mwc-list-item>
              <mwc-list-item value="month">Monat</mwc-list-item>
              <mwc-list-item value="year">Jahr</mwc-list-item>
            </ha-select>
          </div>
        </div>
        <div id="chart"></div>
        <div id="piechart" style="margin-top: 16px;"></div>
      </ha-card>
    `;
  }
}

customElements.define('ladecharts-card', LadechartsCard);
