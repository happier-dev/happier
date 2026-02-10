import type { CatalogAgentId } from '@/backends/types';

const DEFAULT_ACP_PROBE_TIMEOUT_MS = 8_000;
const MAX_TRANSPORT_DERIVED_ACP_PROBE_TIMEOUT_MS = 30_000;

function parseTimeoutMs(raw: string | undefined): number | null {
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

export function resolveAcpProbeTimeoutMs(
    agentName: CatalogAgentId,
    transportInitTimeoutMsRaw?: number,
): number {
    const transportInitTimeoutMs =
      typeof transportInitTimeoutMsRaw === 'number' && Number.isFinite(transportInitTimeoutMsRaw) && transportInitTimeoutMsRaw > 0
        ? transportInitTimeoutMsRaw
        : null;
    const fallbackDefaultMs =
      typeof transportInitTimeoutMs === 'number'
        ? Math.max(
            DEFAULT_ACP_PROBE_TIMEOUT_MS,
            Math.min(transportInitTimeoutMs, MAX_TRANSPORT_DERIVED_ACP_PROBE_TIMEOUT_MS),
          )
        : DEFAULT_ACP_PROBE_TIMEOUT_MS;

    const perAgent = parseTimeoutMs(process.env[`HAPPIER_ACP_PROBE_TIMEOUT_${agentName.toUpperCase()}_MS`]);
    if (typeof perAgent === 'number') return perAgent;

    const global = parseTimeoutMs(process.env.HAPPIER_ACP_PROBE_TIMEOUT_MS);
    if (typeof global === 'number') return global;

    return fallbackDefaultMs;
}
