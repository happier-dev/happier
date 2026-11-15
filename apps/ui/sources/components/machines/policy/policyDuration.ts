const MILLISECONDS = { ms: 1n, s: 1000n, min: 60_000n, h: 3_600_000n, d: 86_400_000n } as const;
type DurationUnit = keyof typeof MILLISECONDS;

/**
 * Every machine-policy Custom duration requires a unit; a bare number never silently changes meaning
 * between rows. Callers name their stored unit and range. Decimal units must convert exactly to that
 * unit (and its measurement step), without rounding or losing safe-integer precision.
 */
export function parsePolicyDuration(raw: string, options: Readonly<{
    unit: DurationUnit;
    minimum: number;
    maximum?: number;
    step?: number;
}>): number | null {
    const match = /^\s*(\d+(?:[.,]\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?|d|days?)\s*$/iu.exec(raw);
    if (!match) return null;
    const suffix = match[2]!.toLowerCase();
    const unit: DurationUnit = suffix === 'ms' || suffix.startsWith('millisecond') ? 'ms'
        : suffix.startsWith('s') ? 's' : suffix.startsWith('m') ? 'min' : suffix.startsWith('h') ? 'h' : 'd';
    const [whole, fraction = ''] = match[1]!.replace(',', '.').split('.');
    const numerator = BigInt(`${whole}${fraction}`) * MILLISECONDS[unit];
    const denominator = 10n ** BigInt(fraction.length) * MILLISECONDS[options.unit];
    if (numerator % denominator !== 0n) return null;
    const integer = numerator / denominator;
    if (integer > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const value = Number(integer);
    return value >= options.minimum && value <= (options.maximum ?? Number.MAX_SAFE_INTEGER)
        && value % (options.step ?? 1) === 0 ? value : null;
}

const PREFILL_UNITS = [['d', MILLISECONDS.d], ['h', MILLISECONDS.h], ['min', MILLISECONDS.min], ['s', MILLISECONDS.s]] as const;

/**
 * A Custom prompt's pre-filled value in the same grammar `parsePolicyDuration` reads: the largest unit that holds the
 * stored milliseconds exactly ("2 d", "90 min"), so a person edits a duration, never a raw millisecond count.
 */
export function formatPolicyDurationInput(ms: number): string {
    const value = BigInt(Math.max(0, Math.trunc(ms)));
    if (value === 0n) return '0 min';
    const unit = PREFILL_UNITS.find(([, size]) => value % size === 0n);
    return unit ? `${value / unit[1]} ${unit[0]}` : `${value} ms`;
}
