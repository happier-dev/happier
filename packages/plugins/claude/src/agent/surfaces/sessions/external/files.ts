import { createHash } from 'node:crypto';
import { opendir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/experimental/sessions';

import { resolveClaudeConfigDir } from './source.js';

export type ResolvedClaudeJsonlSessionFile = Readonly<{
    filePath: string;
    fileRelPath: string;
    projectId: string;
}>;

export type DiscoveredClaudeJsonlSession = Readonly<{
    remoteSessionId: string;
    projectId: string;
    filePath: string;
    updatedAtMs: number;
}>;

export type ClaudeJsonlSessionTraversalEntry = DiscoveredClaudeJsonlSession & Readonly<{
    traversalKey: string;
    scanPosition: ClaudeJsonlSessionScanPosition;
}>;

export type ClaudeJsonlSessionScanPosition = Readonly<{
    projectId: string;
    sessionEntryOffset: number;
}>;

export type ClaudeJsonlSessionIdSnapshot = Readonly<{
    matches: readonly DiscoveredClaudeJsonlSession[];
    sourceGeneration: string;
}>;

export async function readClaudeJsonlFileSize(
    filePath: string,
    signal?: AbortSignal,
): Promise<number> {
    throwIfAborted(signal);
    try {
        const file = await stat(filePath);
        throwIfAborted(signal);
        return file.isFile() ? file.size : 0;
    } catch {
        throwIfAborted(signal);
        return 0;
    }
}

export function isSafeClaudeJsonlPathSegment(value: string): boolean {
    if (!value) return false;
    if (value.includes('/') || value.includes('\\')) return false;
    return value !== '.' && value !== '..';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
}

async function resolveCandidateSourceGeneration(
    projectsDir: string,
    projectIds: readonly string[],
    signal?: AbortSignal,
): Promise<string> {
    const hash = createHash('sha256');
    const root = await stat(projectsDir, { bigint: true });
    hash.update(`${root.dev}:${root.ino}:${root.mtimeNs}:${root.ctimeNs}\n`);
    for (const projectId of projectIds) {
        throwIfAborted(signal);
        const project = await stat(join(projectsDir, projectId), { bigint: true }).catch(() => null);
        if (!project?.isDirectory()) {
            hash.update(`${projectId}:missing\n`);
            continue;
        }
        hash.update(
            `${projectId}:${project.dev}:${project.ino}:${project.mtimeNs}:${project.ctimeNs}\n`,
        );
    }
    return hash.digest('base64url');
}

/**
 * Reads one deterministic lexical scan chunk. It may materialize the bounded
 * directory-name set needed to resume, but it stats and projects only the
 * caller's candidate chunk; exact recency ordering remains the host index's job.
 */
export async function pageClaudeJsonlSessionFiles(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    afterTraversalKey?: string | null;
    scanPosition?: ClaudeJsonlSessionScanPosition | null;
    skip?: number;
    limit: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    entries: readonly ClaudeJsonlSessionTraversalEntry[];
    hasMore: boolean;
    sourceGeneration: string;
    nextScanPosition: ClaudeJsonlSessionScanPosition | null;
    scanned: number;
}>> {
    throwIfAborted(params.signal);
    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const preferredProjectId = resolvePreferredProjectId(params.source);
    const afterTraversalKey = params.afterTraversalKey ?? '';
    const skip = Math.max(0, Math.trunc(params.skip ?? 0));
    const limit = Math.max(1, Math.trunc(params.limit));
    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const projectIds = projectEntries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => String(entry.name))
        .filter((projectId) => isSafeClaudeJsonlPathSegment(projectId))
        .filter((projectId) => !preferredProjectId || projectId === preferredProjectId)
        .sort((left, right) => left.localeCompare(right));
    if (projectIds.length === 0) {
        return {
            entries: [],
            hasMore: false,
            sourceGeneration: createHash('sha256').update('empty').digest('base64url'),
            nextScanPosition: null,
            scanned: 0,
        };
    }
    const sourceGeneration = await resolveCandidateSourceGeneration(
        projectsDir,
        projectIds,
        params.signal,
    );
    const selected: ClaudeJsonlSessionTraversalEntry[] = [];
    let skipped = 0;
    let hasMore = false;
    let nextScanPosition: ClaudeJsonlSessionScanPosition | null = null;
    for (const projectId of projectIds) {
        throwIfAborted(params.signal);
        if (params.scanPosition && projectId.localeCompare(params.scanPosition.projectId) < 0) {
            continue;
        }
        const projectPath = join(projectsDir, projectId);
        const directory = await opendir(projectPath).catch(() => null);
        if (!directory) continue;
        let sessionEntryOffset = 0;
        for await (const entry of directory) {
            sessionEntryOffset += 1;
            throwIfAborted(params.signal);
            if (
                params.scanPosition
                && projectId === params.scanPosition.projectId
                && sessionEntryOffset <= params.scanPosition.sessionEntryOffset
            ) {
                continue;
            }
            if (!entry.isFile() || entry.isSymbolicLink()) continue;
            const name = String(entry.name);
            if (!name.endsWith('.jsonl')) continue;
            const remoteSessionId = name.slice(0, -'.jsonl'.length);
            if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) continue;
            const traversalKey = `${projectId}\u0000${remoteSessionId}`;
            if (!params.scanPosition && traversalKey.localeCompare(afterTraversalKey) <= 0) continue;
            if (skipped < skip) {
                skipped += 1;
                continue;
            }
            if (selected.length >= limit) {
                hasMore = true;
                break;
            }
            selected.push({
                remoteSessionId,
                projectId,
                filePath: join(projectPath, `${remoteSessionId}.jsonl`),
                updatedAtMs: 0,
                traversalKey,
                scanPosition: { projectId, sessionEntryOffset },
            });
            nextScanPosition = { projectId, sessionEntryOffset };
        }
        if (hasMore) break;
    }

    const entries: ClaudeJsonlSessionTraversalEntry[] = [];
    for (const entry of selected) {
        throwIfAborted(params.signal);
        try {
            const file = await stat(entry.filePath);
            if (!file.isFile()) continue;
            entries.push({
                ...entry,
                updatedAtMs: Math.trunc(file.mtimeMs),
            });
        } catch {
            throwIfAborted(params.signal);
        }
    }
    throwIfAborted(params.signal);
    const finalSourceGeneration = await resolveCandidateSourceGeneration(
        projectsDir,
        projectIds,
        params.signal,
    );
    if (finalSourceGeneration !== sourceGeneration) {
        throw new Error('Claude candidate source changed during the bounded scan chunk.');
    }
    return {
        entries,
        hasMore,
        sourceGeneration,
        nextScanPosition: hasMore ? nextScanPosition : null,
        scanned: selected.length,
    };
}

function resolvePreferredProjectId(source: ExternalSessionsSource): string | null {
    if (source.kind !== 'claudeConfig') return null;
    const projectId = typeof source.projectId === 'string' ? source.projectId.trim() : '';
    return isSafeClaudeJsonlPathSegment(projectId) ? projectId : null;
}

export async function resolveClaudeJsonlSessionFile(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    signal?: AbortSignal;
}>): Promise<ResolvedClaudeJsonlSessionFile | null> {
    throwIfAborted(params.signal);
    const remoteSessionId = String(params.remoteSessionId ?? '').trim();
    if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) return null;

    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const preferredProjectId = resolvePreferredProjectId(params.source);

    const resolveInProject = async (projectId: string): Promise<ResolvedClaudeJsonlSessionFile | null> => {
        if (!isSafeClaudeJsonlPathSegment(projectId)) return null;
        const filePath = join(projectsDir, projectId, `${remoteSessionId}.jsonl`);
        try {
            const entry = await stat(filePath);
            throwIfAborted(params.signal);
            if (!entry.isFile()) return null;
            return {
                filePath,
                fileRelPath: join('projects', projectId, `${remoteSessionId}.jsonl`).replace(/\\/g, '/'),
                projectId,
            };
        } catch {
            throwIfAborted(params.signal);
            return null;
        }
    };

    if (preferredProjectId) {
        return await resolveInProject(preferredProjectId);
    }

    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    let newest: Readonly<{ resolved: ResolvedClaudeJsonlSessionFile; updatedAtMs: number }> | null = null;
    for (const entry of projectEntries) {
        throwIfAborted(params.signal);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const projectId = typeof entry.name === 'string' ? entry.name : String(entry.name);
        const resolved = await resolveInProject(projectId);
        if (!resolved) continue;
        try {
            const file = await stat(resolved.filePath);
            throwIfAborted(params.signal);
            const updatedAtMs = Math.trunc(file.mtimeMs);
            if (!newest || updatedAtMs > newest.updatedAtMs) {
                newest = { resolved, updatedAtMs };
            }
        } catch {
            throwIfAborted(params.signal);
            continue;
        }
    }
    return newest?.resolved ?? null;
}

export async function findClaudeJsonlSessionsById(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    signal?: AbortSignal;
}>): Promise<ClaudeJsonlSessionIdSnapshot> {
    throwIfAborted(params.signal);
    const remoteSessionId = String(params.remoteSessionId ?? '').trim();
    if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) {
        return {
            matches: [],
            sourceGeneration: createHash('sha256').update('invalid').digest('base64url'),
        };
    }

    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const preferredProjectId = resolvePreferredProjectId(params.source);
    if (preferredProjectId) {
        const projectsRoot = await stat(projectsDir).catch(() => null);
        if (!projectsRoot?.isDirectory()) {
            return {
                matches: [],
                sourceGeneration: createHash('sha256')
                    .update(`empty\n${remoteSessionId}\n`)
                    .digest('base64url'),
            };
        }
    }
    const projectIds = preferredProjectId
        ? [preferredProjectId]
        : (await readdir(projectsDir, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => String(entry.name))
            .filter((projectId) => isSafeClaudeJsonlPathSegment(projectId))
            .sort((left, right) => left.localeCompare(right));
    const candidateSourceGeneration = projectIds.length > 0
        ? await resolveCandidateSourceGeneration(projectsDir, projectIds, params.signal)
        : createHash('sha256').update('empty').digest('base64url');
    const generation = createHash('sha256');
    generation.update(`${candidateSourceGeneration}\n${remoteSessionId}\n`);

    const resolveInProject = async (projectId: string): Promise<DiscoveredClaudeJsonlSession | null> => {
        const filePath = join(projectsDir, projectId, `${remoteSessionId}.jsonl`);
        try {
            const file = await stat(filePath, { bigint: true });
            throwIfAborted(params.signal);
            if (!file.isFile()) return null;
            generation.update(
                `${projectId}:${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}\n`,
            );
            return {
                remoteSessionId,
                projectId,
                filePath,
                updatedAtMs: Math.trunc(Number(file.mtimeMs)),
            };
        } catch {
            throwIfAborted(params.signal);
            generation.update(`${projectId}:missing\n`);
            return null;
        }
    };

    const matches: DiscoveredClaudeJsonlSession[] = [];
    for (const projectId of projectIds) {
        throwIfAborted(params.signal);
        const resolved = await resolveInProject(projectId);
        if (resolved) matches.push(resolved);
    }

    return {
        matches: matches.sort(
            (a, b) =>
                b.updatedAtMs - a.updatedAtMs
                || a.projectId.localeCompare(b.projectId),
        ),
        sourceGeneration: generation.digest('base64url'),
    };
}

export async function discoverClaudeJsonlSessions(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
}>): Promise<readonly DiscoveredClaudeJsonlSession[]> {
    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const projectsDir = join(configDir, 'projects');
    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const sessions: DiscoveredClaudeJsonlSession[] = [];

    for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
        const projectId = typeof projectEntry.name === 'string' ? projectEntry.name : String(projectEntry.name);
        if (!isSafeClaudeJsonlPathSegment(projectId)) continue;
        const projectPath = join(projectsDir, projectId);
        const sessionEntries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
        for (const sessionEntry of sessionEntries) {
            if (!sessionEntry.isFile() || sessionEntry.isSymbolicLink()) continue;
            const name = typeof sessionEntry.name === 'string' ? sessionEntry.name : String(sessionEntry.name);
            if (!name.endsWith('.jsonl')) continue;
            const remoteSessionId = name.slice(0, -'.jsonl'.length);
            if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) continue;
            const filePath = join(projectPath, name);
            try {
                const file = await stat(filePath);
                if (!file.isFile()) continue;
                sessions.push({
                    remoteSessionId,
                    projectId,
                    filePath,
                    updatedAtMs: Math.trunc(file.mtimeMs),
                });
            } catch {
                continue;
            }
        }
    }

    return sessions.sort(
        (a, b) =>
            b.updatedAtMs - a.updatedAtMs
            || a.remoteSessionId.localeCompare(b.remoteSessionId)
            || a.projectId.localeCompare(b.projectId),
    );
}
