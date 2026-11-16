import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

/** Shared budget for selector and legacy external-link Account scans. */
export function resolveSessionIdPrefixScanMaxPages(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
    const raw = (env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(50, parsed) : 10;
}
