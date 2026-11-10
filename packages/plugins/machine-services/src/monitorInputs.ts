import type { HealthCheckResultV1 } from '@happier-dev/plugin-sdk';

export type NormalizedMonitorInput = Readonly<{ monitorId: string; result: HealthCheckResultV1 }>;
const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
function result(status: 'up' | 'down', observedAt: number, label: string): HealthCheckResultV1 {
    return { status, observedAt, evidence: { v: 1, items: [{ source: { kind: 'alert', label },
        author: { kind: 'process' }, text: status === 'up' ? 'Monitor reported healthy.' : 'Monitor reported a failure.' }] } };
}

/** Uptime Kuma 1.23.16 JSON webhook; heartbeat.time is a UTC database timestamp. */
export function normalizeUptimeKumaInput(value: unknown, _receivedAt: number): NormalizedMonitorInput | null {
    const input = record(value);
    const monitor = record(input?.monitor);
    const heartbeat = record(input?.heartbeat);
    const id = monitor?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || heartbeat?.monitorID !== id
        || (heartbeat.status !== 0 && heartbeat.status !== 1) || typeof heartbeat.time !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(heartbeat.time)) return null;
    const observedAt = Date.parse(`${heartbeat.time.replace(' ', 'T')}Z`);
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) return null;
    return { monitorId: String(id), result: result(heartbeat.status === 1 ? 'up' : 'down', observedAt, 'Uptime Kuma') };
}

/** Gatus v5.16.0 custom provider template has no vendor clock; use authenticated receipt time. */
export function normalizeGatusInput(value: unknown, receivedAt: number): NormalizedMonitorInput | null {
    const input = record(value);
    if (!input || typeof input.endpointGroup !== 'string' || typeof input.endpointName !== 'string' || !input.endpointName
        || (input.status !== 'TRIGGERED' && input.status !== 'RESOLVED')) return null;
    return { monitorId: JSON.stringify([input.endpointGroup, input.endpointName]),
        result: result(input.status === 'RESOLVED' ? 'up' : 'down', receivedAt, 'Gatus') };
}
