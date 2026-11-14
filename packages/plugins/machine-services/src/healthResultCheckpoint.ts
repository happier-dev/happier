import { PLUGIN_ACCOUNT_STORAGE_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import type { HealthResultProjection } from './healthResultProjection.js';

/** Recent samples share the existing checkpoint's actual byte capacity. Latest
 * results, uptime, transition custody and failure state are never truncated. */
export function fitHealthResultCheckpoint<T extends { current?: HealthResultProjection }>(checkpoint: T): T {
    const bytes = (value: T) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (!checkpoint.current || bytes(checkpoint) <= PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes) return checkpoint;
    const current = checkpoint.current;
    const ordered = current.checks.flatMap((check, checkIndex) => (check.recentResults ?? []).map(result => ({ checkIndex, result })))
        .sort((left, right) => left.result.observedAt - right.result.observedAt);
    const trim = (removed: number): T => {
        const omitted = new Map<number, number>();
        const samples = new Map<number, NonNullable<HealthResultProjection['checks'][number]['recentResults']>[number][]>();
        for (let index = 0; index < ordered.length; index++) {
            const { checkIndex, result } = ordered[index]!;
            if (index < removed) omitted.set(checkIndex, result.observedAt);
            else {
                const values = samples.get(checkIndex) ?? [];
                values.push(result); samples.set(checkIndex, values);
            }
        }
        return { ...checkpoint, current: { ...current, checks: current.checks.map((check, index) => {
            const through = omitted.get(index);
            return through === undefined ? check : { ...check, recentResults: samples.get(index) ?? [],
                recentResultsCoverage: 'partial' as const,
                recentResultsOmittedThrough: Math.max(check.recentResultsOmittedThrough ?? 0, through) };
        }) } };
    };
    let low = 0;
    let high = ordered.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (bytes(trim(middle)) <= PLUGIN_ACCOUNT_STORAGE_LIMITS_V1.maximumValueEncodedBytes) high = middle;
        else low = middle + 1;
    }
    // If metadata alone exceeds storage's existing bound, its owner reports the
    // original refusal. This projection does not discard authoritative custody.
    return trim(low);
}
