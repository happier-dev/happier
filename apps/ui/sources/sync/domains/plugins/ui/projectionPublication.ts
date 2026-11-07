import type { PluginUiProjectionModel } from './projection';

/** Share unchanged presentation rows at publication, before any consumer reads them. */
export function reconcilePluginUiProjectionValue<T>(previous: T | undefined, next: T): T {
    if (previous === next) return next;
    if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object'
        || Array.isArray(previous) !== Array.isArray(next)) return next;
    const previousRecord = previous as Readonly<Record<string, unknown>>;
    const nextRecord = next as Readonly<Record<string, unknown>>;
    const keys = Object.keys(nextRecord);
    let unchanged = keys.length === Object.keys(previousRecord).length;
    const values: Record<string, unknown> = {};
    for (const key of keys) {
        const value = reconcilePluginUiProjectionValue(previousRecord[key], nextRecord[key]);
        values[key] = value;
        if (!Object.prototype.hasOwnProperty.call(previousRecord, key) || value !== previousRecord[key]) unchanged = false;
    }
    if (unchanged) return previous;
    return Object.freeze(Array.isArray(next) ? keys.map(key => values[key]) : values) as T;
}

/** Registry generations are clocks; null still distinguishes unestablished declarations. */
export function publishPluginUiProjectionModel(previous: PluginUiProjectionModel | undefined,
    next: PluginUiProjectionModel): PluginUiProjectionModel {
    const comparable = previous && previous.generation !== null && next.generation !== null
        ? Object.freeze({ ...next, generation: previous.generation }) : next;
    const published = reconcilePluginUiProjectionValue(previous, comparable);
    return published === previous || published.generation === next.generation ? published
        : Object.freeze({ ...published, generation: next.generation });
}
