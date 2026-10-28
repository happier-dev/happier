import { z } from 'zod';
import { NETWORK_CEILINGS, NETWORK_PHASES, NETWORK_WORKLOAD_REVISION } from '../../../suites/ui-e2e/session.networkTransfer.contract';
import { NETWORK_HTTP_METHODS, NETWORK_ROUTES, NETWORK_EVENT_FAMILIES, NETWORK_EVENT_TYPES } from './networkTransfer';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bytes = z.union([integer, z.literal('unavailable')]);
const text = z.string().max(256);
const httpSchema = z.object({
  method: z.enum(NETWORK_HTTP_METHODS), route: z.enum(NETWORK_ROUTES),
  requests: integer, failed: integer, inFlight: integer, lateResponses: integer,
  decodedBodyBytes: bytes, encodedBodyBytes: bytes, encodedResponseBytes: bytes, requestBodyBytes: bytes,
  unavailableBodies: integer, cached: integer, serviceWorker: integer,
  statuses: z.record(z.string().regex(/^(?:[1-5][0-9]{2}|unavailable)$/), integer),
  encodings: z.partialRecord(z.enum(['identity', 'gzip', 'br', 'deflate', 'zstd', 'other', 'unavailable']), integer),
}).strict().superRefine((row, ctx) => {
  if ([row.failed, row.inFlight, row.lateResponses, row.unavailableBodies, row.cached, row.serviceWorker].some((n) => n > row.requests)
    || Object.values(row.statuses).reduce((a, b) => a + b, 0) !== row.requests
    || Object.values(row.encodings).reduce((a, b) => a + (b ?? 0), 0) !== row.requests) ctx.addIssue({ code: 'custom', message: 'inconsistent HTTP counts' });
});
const wsSchema = z.object({
  direction: z.enum(['sent', 'received']),
  family: z.enum([...NETWORK_EVENT_FAMILIES, 'unknown', 'socket', 'engine', 'websocket', 'development']),
  type: z.enum([...NETWORK_EVENT_TYPES, 'unknown', 'ack', 'connect', 'disconnect', 'error', 'open', 'close', 'ping', 'pong', 'upgrade', 'noop', 'transport']),
  frames: integer, messages: integer, applicationBytes: integer,
}).strict();
const unique = <T>(rows: T[], key: (row: T) => string) => new Set(rows.map(key)).size === rows.length;
const phaseSchema = z.object({
  name: z.enum(NETWORK_PHASES), durationMs: integer, inFlightAtEnd: integer, socketDisconnects: integer,
  http: z.array(httpSchema).max(NETWORK_HTTP_METHODS.length * NETWORK_ROUTES.length).refine((rows) => unique(rows, (r) => `${r.method}:${r.route}`)),
  webSocket: z.array(wsSchema).max(2 * 32 * 32).refine((rows) => unique(rows, (r) => `${r.direction}:${r.family}:${r.type}`)),
}).strict();

export const networkTransferReportSchema = z.object({
  schemaVersion: z.literal(2), workloadRevision: text, sourceLine: z.literal('0.2'),
  testStatus: z.enum(['passed', 'failed']), status: z.enum(['complete', 'incomplete', 'failed']),
  ci: z.object({ branch: text.nullable(), sha: text.nullable(), run: z.string().regex(/^\d+$/).nullable(), attempt: z.string().regex(/^\d+$/).nullable() }).strict(),
  retry: integer, repeatEachIndex: integer,
  runtime: z.object({ browser: z.literal('chromium'), browserVersion: z.string().regex(/^\d+(?:\.\d+)*$/), uiMode: z.literal('export'), serverMode: z.literal('light-sqlite'), viewport: z.object({ width: integer, height: integer }).strict() }).strict(),
  accounting: z.object({ httpDecodedBodyBytes: text, httpEncodedBodyBytes: text, httpEncodedResponseBytes: text, wsApplicationBytes: text, socketIoCoverage: text }).strict(),
  fixture: z.object({
    sessionCount: integer, seededSessionCount: integer, offPagePins: integer, storageMode: z.literal('plain'),
    burstKind: z.literal('metadata-update'), burstCount: integer, burstPayloadBytes: integer, idleMs: integer,
    coldCache: z.literal('disabled'), warmCache: z.literal('enabled'), verifiedBootstraps: integer,
    openedSessions: integer, reconnects: integer, transcriptMessages: integer, transcriptPayloadBytes: integer,
  }).strict(),
  measurement: z.object({ status: z.enum(['complete', 'incomplete']), wsEncodedBytes: z.literal('unavailable'), lostEvents: integer,
    phases: z.array(phaseSchema).max(NETWORK_PHASES.length).refine((rows) => unique(rows, (r) => r.name)),
  }).strict(),
}).strict();
export type NetworkTransferReport = z.infer<typeof networkTransferReportSchema>;

// Bound untrusted JSON before parsing. Even the dense schema (all method/route,
// status/encoding and WS buckets in all seven phases, pretty-printed) fits here:
// each HTTP row <32 KiB (including all 501 status keys and indentation), each
// WS row <512 bytes; metadata <64 KiB. The producer uses two-space JSON formatting.
export const MAX_NETWORK_REPORT_BYTES = NETWORK_PHASES.length * (NETWORK_HTTP_METHODS.length * NETWORK_ROUTES.length * 32768 + 2 * 32 * 32 * 512) + 65536;
export function parseNetworkTransferReport(raw: string): NetworkTransferReport {
  if (Buffer.byteLength(raw) > MAX_NETWORK_REPORT_BYTES) throw new Error('network report exceeds schema size bound');
  return networkTransferReportSchema.parse(JSON.parse(raw));
}

export function usableNetworkReport(report: NetworkTransferReport): boolean {
  return report.testStatus === 'passed' && report.status !== 'failed'
    && report.measurement.lostEvents === 0
    && report.workloadRevision === NETWORK_WORKLOAD_REVISION
    && report.fixture.seededSessionCount === report.fixture.sessionCount
    && report.fixture.verifiedBootstraps === 2 && report.fixture.openedSessions === 1 && report.fixture.reconnects === 1
    && report.measurement.phases.every((phase) => phase.inFlightAtEnd === 0)
    && NETWORK_PHASES.every((phase, i) => report.measurement.phases[i]?.name === phase);
}

function dimensions(report: NetworkTransferReport) {
  const { seededSessionCount: _, verifiedBootstraps: __, openedSessions: ___, reconnects: ____, ...fixture } = report.fixture;
  return { schema: report.schemaVersion, workload: report.workloadRevision, line: report.sourceLine, runtime: report.runtime, fixture, accounting: report.accounting };
}
export function comparableNetworkReports(current: NetworkTransferReport, base: NetworkTransferReport): boolean {
  return usableNetworkReport(current) && usableNetworkReport(base) && JSON.stringify(dimensions(current)) === JSON.stringify(dimensions(base));
}

type Value = number | 'unavailable';
export function networkMetrics(report: NetworkTransferReport): Map<string, Value> {
  const metrics = new Map<string, Value>();
  for (const phase of report.measurement.phases) {
    const put = (metric: string, value: Value) => metrics.set(`${phase.name}|${metric}`, report.measurement.lostEvents > 0 ? 'unavailable' : value);
    put('durationMs (informational)', phase.durationMs);
    put('socketDisconnects (informational)', phase.socketDisconnects);
    for (const row of phase.http) {
      for (const metric of ['requests', 'requestBodyBytes', 'decodedBodyBytes', 'encodedBodyBytes', 'encodedResponseBytes'] as const) put(`${row.method} ${row.route} ${metric}`, row[metric]);
    }
    for (const metric of ['requests', 'decodedBodyBytes'] as const) {
      const rows = phase.http.filter((row) => row.method === 'GET' && row.route.startsWith('session-list'));
      put(`GET session-list* ${metric}`, (phase.name.endsWith('-home') && rows.length === 0) || rows.some((r) => r[metric] === 'unavailable') ? 'unavailable' : rows.reduce((sum, r) => sum + Number(r[metric]), 0));
    }
    put('GET exact-session requests', phase.http.filter((r) => r.method === 'GET' && r.route === 'exact-session').reduce((sum, r) => sum + r.requests, 0));
    for (const row of phase.webSocket) {
      for (const metric of ['frames', 'messages', 'applicationBytes'] as const) put(`WS ${row.direction} ${row.family}/${row.type} ${metric}`, row[metric]);
    }
    for (const metric of ['frames', 'applicationBytes'] as const) {
      put(`WS received update/update-session ${metric}`, phase.webSocket.filter((r) => r.direction === 'received' && r.family === 'update' && r.type === 'update-session').reduce((sum, r) => sum + r[metric], 0));
    }
  }
  return metrics;
}

export function compareNetworkTransfer(current: NetworkTransferReport, base?: NetworkTransferReport) {
  const comparable = base !== undefined && comparableNetworkReports(current, base);
  const values = networkMetrics(current);
  const previous = base ? networkMetrics(base) : new Map<string, Value>();
  const ceilings = new Map(NETWORK_CEILINGS.map((c) => [`${c.phase}|${c.metric}`, c.maximum]));
  const violations: string[] = [];
  const rows = ['| Phase | Metric | Base | This run | Delta | Ceiling | Status |', '| --- | --- | ---: | ---: | --- | ---: | --- |'];
  if (!usableNetworkReport(current)) violations.push('current workload failed or is incomplete');
  const valueFor = (report: NetworkTransferReport | undefined, metrics: Map<string, Value>, key: string): Value => {
    const observed = metrics.get(key);
    if (observed !== undefined) return observed;
    const phase = report?.measurement.phases.find((p) => p.name === key.split('|')[0]);
    // An absent class in an observed, finished phase means no traffic. A missing
    // phase or lost events cannot establish a zero-byte or zero-request result.
    return report?.testStatus === 'passed' && report.measurement.lostEvents === 0 && phase?.inFlightAtEnd === 0 ? 0 : 'unavailable';
  };
  for (const key of new Set([...values.keys(), ...previous.keys(), ...ceilings.keys()])) {
    const [phase, metric] = key.split('|');
    const value = valueFor(current, values, key);
    const before = valueFor(base, previous, key);
    const maximum = ceilings.get(key);
    const exceeded = maximum !== undefined && (typeof value !== 'number' || value > maximum);
    if (exceeded) violations.push(`${phase}: ${metric}`);
    const delta = comparable && typeof value === 'number' && typeof before === 'number' ? `${value - before >= 0 ? '+' : ''}${value - before}` : 'not comparable';
    const status = exceeded ? 'ceiling exceeded / unavailable' : maximum !== undefined ? 'within ceiling' : 'informational';
    rows.push(`| ${phase} | ${metric} | ${base ? comparable ? before ?? 'unavailable' : 'not comparable' : 'missing'} | ${value} | ${delta} | ${maximum ?? '—'} | ${status} |`);
  }
  return { violations, comparable, markdown: `Workload/gate: ${violations.length > 0 ? 'failed' : 'passed'}; functional test: ${current.testStatus}.\n\n${rows.join('\n')}\n\nMeasurement: ${current.status}; lost events: ${current.measurement.lostEvents}. Missing byte evidence is unavailable; WS bytes are decompressed application payloads. Timing, compression and heartbeat metrics are informational.\n` };
}
