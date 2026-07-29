import path from 'node:path';

import type { LocalServiceWorkspaceFact } from './provenance';

export type LocalServiceWorkspaceSessionMarker = Readonly<{
    happySessionId?: string;
    cwd?: unknown;
    metadata?: unknown;
    respawn?: unknown;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeWorkspacePath(value: unknown): string | null {
    const raw = readTrimmedString(value);
    if (!raw || !path.isAbsolute(raw)) return null;
    const normalized = path.normalize(raw);
    const root = path.parse(normalized).root;
    return normalized.length > root.length
        ? normalized.replace(/[\\/]+$/u, '')
        : normalized;
}

function readMarkerWorkspacePathCandidates(marker: LocalServiceWorkspaceSessionMarker): readonly string[] {
    const metadata = readRecord(marker.metadata);
    const respawn = readRecord(marker.respawn);
    return [
        readTrimmedString(marker.cwd),
        readTrimmedString(metadata?.path),
        readTrimmedString(respawn?.directory),
    ].filter((candidate) => candidate.length > 0);
}

export function mergeLocalServiceWorkspaceFacts(
    ...sources: readonly (readonly LocalServiceWorkspaceFact[])[]
): readonly LocalServiceWorkspaceFact[] {
    const byPath = new Map<string, LocalServiceWorkspaceFact>();
    for (const source of sources) {
        for (const fact of source) {
            const normalized = normalizeWorkspacePath(fact.path);
            if (!normalized || byPath.has(normalized)) continue;
            byPath.set(normalized, {
                ...(fact.id ? { id: fact.id } : {}),
                path: normalized,
            });
        }
    }
    return Object.freeze([...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)));
}

export function resolveLocalServiceWorkspaceFactsFromSessionMarkers(
    markers: readonly LocalServiceWorkspaceSessionMarker[],
): readonly LocalServiceWorkspaceFact[] {
    const facts: LocalServiceWorkspaceFact[] = [];
    for (const marker of markers) {
        for (const candidate of readMarkerWorkspacePathCandidates(marker)) {
            const normalized = normalizeWorkspacePath(candidate);
            if (!normalized) continue;
            facts.push({ path: normalized });
        }
    }
    return mergeLocalServiceWorkspaceFacts(facts);
}

/**
 * Resolve the normalized workspace path(s) a given session id is anchored to, from
 * session markers. Used by the launcher feed to turn a per-request `sessionId` into a
 * workspace-PATH scope (D1): every service in that path is kept, regardless of which
 * session started it. Returns an empty array when the session has no resolvable marker.
 */
export function resolveSessionWorkspacePathsFromSessionMarkers(
    markers: readonly LocalServiceWorkspaceSessionMarker[],
    sessionId: string,
): readonly string[] {
    const target = readTrimmedString(sessionId);
    if (!target) return [];
    const paths = new Set<string>();
    for (const marker of markers) {
        if (readTrimmedString(marker.happySessionId) !== target) continue;
        for (const candidate of readMarkerWorkspacePathCandidates(marker)) {
            const normalized = normalizeWorkspacePath(candidate);
            if (normalized) {
                paths.add(normalized);
            }
        }
    }
    return Object.freeze([...paths]);
}
