import type { ExternalSessionsSource } from '@happier-dev/protocol';

function serializeBoundedJsonValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (Array.isArray(value)) {
        return `[${value.map(serializeBoundedJsonValue).join(',')}]`;
    }
    if (typeof value !== 'object') return 'null';

    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serializeBoundedJsonValue(record[key])}`)
        .join(',')}}`;
}

/**
 * Stable structural serialization for local UI equality/signature checks.
 *
 * This is deliberately not a persisted source key: installed Agent declarations
 * remain the sole owner of canonical source keys.
 */
export function serializeExternalSessionSourceForComparison(
    source: ExternalSessionsSource,
): string {
    return serializeBoundedJsonValue(source);
}

export function serializeExternalSessionJsonForComparison(value: unknown): string {
    return serializeBoundedJsonValue(value);
}
