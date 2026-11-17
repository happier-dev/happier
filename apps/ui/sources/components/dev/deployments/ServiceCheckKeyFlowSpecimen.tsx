import * as React from 'react';
import type { TelemetryKeyFlowConfigV1, TelemetryMetricsReadResultV1 } from '@happier-dev/database-protocol';

import { ServiceCheckList } from '@/components/projects/deployments/ServiceCheckList';
import { ServiceCheckPageBody } from '@/components/projects/deployments/ServiceCheckPage';
import {
  ServiceCheckCollectorTrendReaderContext,
  type ServiceCheckCollectorTrendReader,
} from '@/components/projects/deployments/useServiceCheckCollectorTrend';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { ItemList } from '@/components/ui/lists/ItemList';

/**
 * Dev-only specimen of a Key flow check (lab p7Flows detail/unknown, p7Surfaces checks/monitoring): the real check page
 * and the real Checks list over fixture results, with the collector read answered at its network edge.
 * `?state=failing|unknown|passing`, `?view=page|list|cards`.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;
const SCOPE = Object.freeze({ serverId: 'specimen-server', accountId: 'specimen-account' });
const COLLECTOR = 'hetzner-fsn1';
/** The failing flow's newest measurement: the check result, its trend's newest interval and its route all read it. */
const FAILING_P95 = 1420;
const FAILING_ERROR_RATE = 0.024;

type State = 'failing' | 'unknown' | 'passing';

function flow(name: 'Checkout' | 'Assist'): TelemetryKeyFlowConfigV1 {
  return { name, environmentId: 'env-billing-prod', serviceName: 'billing-api', windowMs: 10 * MINUTE,
    measure: { kind: 'route', statistic: 'p95', routes: name === 'Checkout'
      ? [{ method: 'GET', route: '/api/cart' }, { method: 'POST', route: '/checkout' }]
      : [{ method: 'POST', route: '/api/assist/summarize' }] },
    threshold: { operator: 'above', value: name === 'Checkout' ? 800 : 4000 } };
}

/** A smooth, plausible series: a daily swell plus a little noise, deterministic per index. */
function wave(index: number, base: number, spread: number) {
  return base + spread * Math.sin(index / 7) + (spread / 3) * Math.sin(index * 1.7);
}

function results(state: State, latency: (index: number) => number) {
  return Array.from({ length: 60 }, (_, index) => {
    const age = 59 - index;
    const failing = state === 'failing' && age < 3;
    const unknown = state === 'unknown' && age < 11;
    const observedAt = NOW - age * MINUTE;
    const value = failing ? FAILING_P95 - age * 20 : latency(index);
    // The finite Key flow Action's result shape: reason codes stay codes; the UI words them from the measurement. A
    // breached limit is failing (degraded), never down (D33).
    return { status: failing ? 'degraded' : unknown ? 'unknown' : 'up', observedAt,
      ...(unknown ? {} : { latencyMs: value }),
      measurements: { measure: 'p95', unit: 'ms', basis: 'metric_points', producers: [{ serviceName: 'billing-api' }],
        window: { since: observedAt - 10 * MINUTE, until: observedAt }, completeness: unknown ? 'unknown' : 'complete',
        reasons: unknown ? ['no_traffic'] : [],
        ...(unknown ? {} : { value, p95Ms: value, errorRate: failing ? FAILING_ERROR_RATE - age * 0.001 : 0.002, requestCount: 140 }) },
      cause: { kind: 'keyFlow', vantage: 'sameMachine', reason: failing ? 'threshold_exceeded' : unknown ? 'no_traffic' : 'within_threshold' },
      evidence: { kind: 'none' } };
  });
}

function history(state: State) {
  const today = Math.floor(NOW / DAY) * DAY;
  return { lastObservedAt: NOW, uptimePercent: state === 'failing' ? 99.4 : 99.6,
    days: Array.from({ length: 25 }, (_, index) => {
      const ago = 24 - index;
      const bad = state === 'failing' && ago <= 1;
      return { dayStartAt: today - ago * DAY, up: bad ? 1380 : 1440, down: 0, degraded: bad ? 60 : 0, unknown: 0,
        uptimePercent: bad ? 96.7 : 100 };
    }) };
}

function checkRow(input: Readonly<{ key: string; name: 'Checkout' | 'Assist'; state: State }>): ManagedConfiguredCheckRow {
  const recent = results(input.state, (index) => Math.round(wave(index, 240, 40)));
  return {
    kind: 'configuredCheck', key: input.key, scope: SCOPE, automationId: `automation-${input.key}`, triggerId: 'trigger-1',
    native: { name: input.name, templateVersion: 1, enabled: true, triggers: [] } as never,
    definitionFacts: { kind: 'available', observerMachineId: COLLECTOR, checks: [{ checkId: input.name, name: 'Key flow',
      targetLabel: input.name === 'Checkout' ? 'GET /api/cart, POST /checkout' : 'POST /api/assist/summarize', periodMs: MINUTE,
      domainId: null, keyFlow: flow(input.name) }] },
    lastResults: { kind: 'available', checks: [{ checkId: input.name, result: recent.at(-1)!, recentResults: recent,
      recentResultsCoverage: 'complete', history: history(input.state),
      ...(input.state === 'failing' ? { failingSince: NOW - 3 * MINUTE, failureStreak: 3 } : {}) }] },
  } as never;
}

function httpRow(target: 'billing.acme.dev/health' | 'n8n.acme.dev'): ManagedConfiguredCheckRow {
  // n8n answers 502 from outside: an unreachable target, the one case that reads Down (rose).
  const down = target === 'n8n.acme.dev';
  const recent = results('passing', (index) => Math.round(wave(index, 140, 20))).map((result, index) => down && index >= 54
    ? { ...result, status: 'down', measurements: undefined, cause: { kind: 'http', vantage: 'outside', httpStatus: 502, expectStatus: 200 } }
    : { ...result, measurements: undefined, cause: undefined });
  const key = down ? 'n8n' : 'billing-health';
  return {
    kind: 'configuredCheck', key, scope: SCOPE, automationId: `automation-${key}`, triggerId: 'trigger-1',
    native: { name: target, templateVersion: 1, enabled: true, triggers: [] } as never,
    definitionFacts: { kind: 'available', observerMachineId: COLLECTOR, checks: [{ checkId: 'http', name: 'HTTP',
      targetLabel: target, periodMs: MINUTE, domainId: null, keyFlow: null }] },
    lastResults: { kind: 'available', checks: [{ checkId: 'http', result: recent.at(-1)!, recentResults: recent,
      recentResultsCoverage: 'complete', history: { ...history('passing'), uptimePercent: down ? 93.1 : 99.98 },
      ...(down ? { failingSince: NOW - 6 * MINUTE, failureStreak: 6 } : {}) }] },
  } as never;
}

/** The collector's 24-hour answer for a flow: 15-minute intervals, a regression after the last deploy when failing. */
function collectorRead(config: TelemetryKeyFlowConfigV1, state: State, until: number): TelemetryMetricsReadResultV1 {
  const step = 15 * MINUTE;
  const count = DAY / step;
  const regressionAt = count - 6;
  const trend = Array.from({ length: count }, (_, index) => {
    const since = until - DAY + index * step;
    const quiet = state === 'unknown' && index >= count - 2;
    const regressed = state === 'failing' && index >= regressionAt;
    // The newest interval is the window the newest check result measured, so the trend heads and the facts agree.
    const newest = regressed && index === count - 1;
    const p95 = newest ? FAILING_P95 : regressed ? wave(index, 1380, 60) : wave(index, config.threshold.value * 0.4, config.threshold.value * 0.06);
    const errorRate = newest ? FAILING_ERROR_RATE : regressed ? 0.023 + 0.002 * Math.sin(index)
      : 0.002 + 0.0006 * Math.sin(index / 5) + 0.0003 * Math.sin(index * 1.3);
    return quiet ? { since, until: since + step, unit: 'ms', count: 0 }
      : { since, until: since + step, unit: 'ms', value: p95, p95, errorRate, count: 120 };
  });
  const route = (method: string, path: string, p95Ms: number, errorRate: number, requestCount: number) => ({ method, route: path,
    result: { status: p95Ms > config.threshold.value ? 'degraded' : 'up', observedAt: until, evidence: { v: 1, items: [] },
      measurements: { measure: 'p95', value: p95Ms, unit: 'ms', basis: 'metric_points', producers: [{ serviceName: 'billing-api' }],
        window: { since: until - DAY, until }, completeness: 'complete', reasons: [], p95Ms, errorRate, requestCount } } }) as never;
  const routes = config.measure.kind === 'route' && config.measure.routes.length > 1
    ? [route('POST', '/checkout', state === 'failing' ? FAILING_P95 : 412, state === 'failing' ? FAILING_ERROR_RATE : 0.004, 961),
      route('GET', '/api/cart', 96, 0.003, 2410)]
    : [route('POST', '/api/assist/summarize', state === 'unknown' ? 2840 : 2100, 0, 1640)];
  return { result: { status: state === 'failing' ? 'degraded' : state === 'unknown' ? 'unknown' : 'up', observedAt: until,
    evidence: { v: 1, items: [] } } as never, routes, trend };
}

export function ServiceCheckKeyFlowSpecimen(props: Readonly<{ state: State; view: 'page' | 'list' | 'cards' }>) {
  const reader = React.useCallback<ServiceCheckCollectorTrendReader>(async (input) =>
    collectorRead(input.config, input.config.measure.kind === 'route' && input.config.measure.routes.length > 1 ? props.state
      : props.state === 'unknown' ? 'unknown' : 'passing', input.until), [props.state]);
  const name = props.state === 'unknown' ? 'Assist' : 'Checkout';
  const rows = React.useMemo(() => [checkRow({ key: 'checkout', name: 'Checkout', state: props.state === 'unknown' ? 'passing' : props.state }),
    checkRow({ key: 'assist', name: 'Assist', state: props.state === 'unknown' ? 'unknown' : 'passing' }),
    httpRow('n8n.acme.dev'), httpRow('billing.acme.dev/health')], [props.state]);
  const shown = rows.find((row) => row.native.name === name)!;
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const selection = React.useMemo(() => ({ selectedKey, onSelect: (row: ManagedConfiguredCheckRow) => setSelectedKey(row.key),
    onSelectedRow: () => {} }), [selectedKey]);
  return (
    <ServiceCheckCollectorTrendReaderContext.Provider value={reader}>
      {props.view === 'page' ? (
        <ItemList testID="services.check.page"><ServiceCheckPageBody row={shown} /></ItemList>
      ) : (
        // Monitoring's own wide column, so the list draws every column it has room for there.
        <ItemList pageColumn="wide">
          <ServiceCheckList rows={rows} scope={SCOPE} selection={selection} testID="specimen.checks"
            accessibilityLabel="Checks" presentation={props.view === 'cards' ? 'grid' : 'list'} />
        </ItemList>
      )}
    </ServiceCheckCollectorTrendReaderContext.Provider>
  );
}
