/** @moduleRealm daemon */
import { createHash } from 'node:crypto';

type StrictJson =
    | null
    | boolean
    | number
    | string
    | readonly StrictJson[]
    | Readonly<{ [key: string]: StrictJson }>;

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isStrictJsonArray(value: StrictJson): value is readonly StrictJson[] {
    return Array.isArray(value);
}

function canonicalJson(value: StrictJson): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') return JSON.stringify(value);
    if (isStrictJsonArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
        .join(',')}}`;
}

function readStrictJson(value: unknown): StrictJson | null {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) {
        const items = value.map(readStrictJson);
        return items.some((item, index) => item === null && value[index] !== null)
            ? null
            : Object.freeze(items as StrictJson[]);
    }
    if (!value || typeof value !== 'object') return null;
    const record = value as Readonly<Record<string, unknown>>;
    const parsed = Object.create(null) as Record<string, StrictJson>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        const normalized = readStrictJson(item);
        if (normalized === null && item !== null) return null;
        parsed[key] = normalized;
    }
    return Object.freeze(parsed);
}

/**
 * Opaque identity for a private candidate. It deliberately includes linkData,
 * unlike the public ExternalSessionRef, so owners can preserve their existing
 * deterministic order without projecting private identity to consumers.
 */
export function resolveExternalSessionCandidateIdentityKey(
    candidate: Readonly<{
        remoteSessionId: string;
        linkData?: unknown;
    }>,
): string {
    if (!candidate.remoteSessionId) {
        throw new Error('External-session candidate identity requires a remote session id');
    }
    const linkData = candidate.linkData === undefined
        ? null
        : readStrictJson(candidate.linkData);
    if (
        candidate.linkData !== undefined
        && (
            !linkData
            || typeof linkData !== 'object'
            || Array.isArray(linkData)
        )
    ) {
        throw new Error('External-session candidate identity requires strict JSON link data');
    }
    return createHash('sha256').update(canonicalJson({
        linkData,
        remoteSessionId: candidate.remoteSessionId,
    }), 'utf8').digest('hex');
}

/**
 * Canonical private Browse ordering. Public projections can reuse the final
 * opaque tie-break without retaining or exposing linkData.
 */
export function compareExternalSessionCandidatePrecedence(
    left: Readonly<{
        remoteSessionId: string;
        updatedAtMs: number;
        linkData?: unknown;
    }>,
    right: Readonly<{
        remoteSessionId: string;
        updatedAtMs: number;
        linkData?: unknown;
    }>,
): number {
    return right.updatedAtMs - left.updatedAtMs
        || compareCodeUnits(left.remoteSessionId, right.remoteSessionId)
        || compareCodeUnits(
            resolveExternalSessionCandidateIdentityKey(left),
            resolveExternalSessionCandidateIdentityKey(right),
        );
}
