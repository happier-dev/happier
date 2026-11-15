import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

/** Shared replay-input policy for Continue and Fork, including standalone callers. */
export function readReplayTextLimitFromEnv(): number | null {
    const rawValue = sessionProcessEnvironment().HAPPIER_REPLAY_MAX_TEXT_CHARS;
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return null;
    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsedValue)) return null;
    return Math.min(50_000, Math.max(1, parsedValue));
}
