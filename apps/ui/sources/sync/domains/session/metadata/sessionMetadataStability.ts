import type { Metadata } from '@/sync/domains/state/storageTypes';

const METADATA_TIMESTAMP_ONLY_KEYS = new Set([
    'readStateV1',
]);

const METADATA_NESTED_FRESHNESS_RECORD_KEYS = new Set([
    'summary',
    'acpSessionModesV1',
    'sessionModesV1',
    'acpSessionModelsV1',
    'sessionModelsV1',
    'acpConfigOptionsV1',
    'sessionConfigOptionsV1',
    'acpConfiguredBackendV1',
]);

const UPDATED_AT_KEY = new Set(['updatedAt']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function omitRecordKeys(value: unknown, keysToOmit: ReadonlySet<string>): unknown {
    if (!isRecord(value)) return value;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        if (keysToOmit.has(key)) continue;
        next[key] = value[key];
    }
    return next;
}

export function buildSessionMetadataStabilitySignatureValue(
    metadata: Metadata | null | undefined,
): unknown {
    if (!metadata) return null;
    const record = metadata as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(record)) {
        if (METADATA_TIMESTAMP_ONLY_KEYS.has(key)) {
            continue;
        }
        const value = record[key];
        next[key] = METADATA_NESTED_FRESHNESS_RECORD_KEYS.has(key)
            ? omitRecordKeys(value, UPDATED_AT_KEY)
            : value;
    }

    return next;
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }
    if (!isRecord(value)) {
        return value;
    }

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
}

export function buildStableJsonSignature(value: unknown): string {
    try {
        return JSON.stringify(sortJsonValue(value ?? null)) ?? 'null';
    } catch {
        return String(value);
    }
}

export function buildSessionMetadataStabilitySignature(metadata: Metadata | null | undefined): string {
    return buildStableJsonSignature(buildSessionMetadataStabilitySignatureValue(metadata));
}
