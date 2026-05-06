function parseEnvBoundedInt(
    name: string,
    bounds: Readonly<{ min: number; max: number }>,
    fallback: number | null,
): number | null {
    const rawValue = process.env[name];
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return fallback;
    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsedValue)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsedValue));
}

export function readReplayTextLimitFromEnv(): number | null {
    return parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);
}
