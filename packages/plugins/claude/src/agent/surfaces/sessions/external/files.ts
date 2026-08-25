import { createHash } from 'node:crypto';
import { lstat, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { compareExternalSessionCandidatePrecedence } from '@happier-dev/plugin-sdk/sessions/external';

import { resolveClaudeConfigDir, type ClaudeExternalSessionSource } from './source.js';

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
    /** Source generation scoped to this entry's own resume point. */
    sourceGeneration: string;
}>;

export type ClaudeJsonlSessionScanPoint = Readonly<{
    scanPosition: ClaudeJsonlSessionScanPosition;
    sourceGeneration: string;
}>;

export class ClaudeCandidateSourceChangedError extends Error {
    readonly name = 'ClaudeCandidateSourceChangedError';
}

export type ClaudeJsonlSessionScanPosition = Readonly<{
    projectId: string;
    sessionEntryOffset: number;
}>;

export type ClaudeJsonlSessionIdSnapshot = Readonly<{
    matches: readonly DiscoveredClaudeJsonlSession[];
    sourceGeneration: string;
}>;

type AuthorizedClaudeProjectsRoot = Readonly<{
    projectsRoot: string;
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

/**
 * Fingerprints the enumerated project set. This is the whole answer for lookups
 * whose result IS every project, so any project appearing or disappearing must
 * invalidate them.
 */
function resolveProjectListGeneration(projectIds: readonly string[]): string {
    const hash = createHash('sha256');
    hash.update(`projects:${projectIds.length}\n`);
    for (const projectId of projectIds) {
        hash.update(`${projectId}\n`);
    }
    return hash.digest('base64url');
}

/**
 * Fingerprints exactly what a resume point depends on: the directory whose raw
 * `opendir` entry offsets the cursor resumes at. Resumption anchors on the resume
 * project name plus an offset inside that one directory, so projects created or
 * removed anywhere else cannot shift the anchor and must not invalidate the
 * cursor.
 */
async function resolveResumeProjectGeneration(
    projectsDir: string,
    resumeProjectId: string | null,
    signal?: AbortSignal,
): Promise<string> {
    throwIfAborted(signal);
    const hash = createHash('sha256');
    hash.update('resume\n');
    if (!resumeProjectId) {
        hash.update('none\n');
        return hash.digest('base64url');
    }
    const project = await stat(join(projectsDir, resumeProjectId), { bigint: true }).catch(() => null);
    throwIfAborted(signal);
    hash.update(project?.isDirectory()
        ? `${resumeProjectId}:${project.dev}:${project.ino}:${project.mtimeNs}:${project.ctimeNs}\n`
        : `${resumeProjectId}:missing\n`);
    return hash.digest('base64url');
}

/**
 * Reads one deterministic lexical scan chunk. It may materialize the bounded
 * directory-name set needed to resume, but it stats and projects only the
 * caller's candidate chunk; exact recency ordering remains the host index's job.
 */
export async function pageClaudeJsonlSessionFiles(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    afterTraversalKey?: string | null;
    scanPosition?: ClaudeJsonlSessionScanPosition | null;
    skip?: number;
    limit: number;
    signal?: AbortSignal;
}>): Promise<Readonly<{
    entries: readonly ClaudeJsonlSessionTraversalEntry[];
    hasMore: boolean;
    /** Source generation scoped to the resume point this chunk was asked to continue from. */
    sourceGeneration: string;
    nextScanPoint: ClaudeJsonlSessionScanPoint | null;
    scanned: number;
}>> {
    throwIfAborted(params.signal);
    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const authorizedProjectsRoot = await resolveAuthorizedClaudeProjectsRoot({
        configDir,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!authorizedProjectsRoot) {
        return {
            entries: [],
            hasMore: false,
            sourceGeneration: createHash('sha256').update('empty').digest('base64url'),
            nextScanPoint: null,
            scanned: 0,
        };
    }
    const projectsDir = authorizedProjectsRoot.projectsRoot;
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
            nextScanPoint: null,
            scanned: 0,
        };
    }
    const capturedGenerations = new Map<string, string>();
    const captureSourceGeneration = async (resumeProjectId: string | null): Promise<string> => {
        const key = resumeProjectId ?? '';
        const captured = capturedGenerations.get(key);
        if (captured !== undefined) return captured;
        const generation = await resolveResumeProjectGeneration(
            projectsDir,
            resumeProjectId,
            params.signal,
        );
        capturedGenerations.set(key, generation);
        return generation;
    };
    const sourceGeneration = await captureSourceGeneration(params.scanPosition?.projectId ?? null);
    const selected: ClaudeJsonlSessionTraversalEntry[] = [];
    let skipped = 0;
    let hasMore = false;
    let nextScanPoint: ClaudeJsonlSessionScanPoint | null = null;
    for (const projectId of projectIds) {
        throwIfAborted(params.signal);
        if (params.scanPosition && projectId.localeCompare(params.scanPosition.projectId) < 0) {
            continue;
        }
        const projectPath = join(projectsDir, projectId);
        const projectSourceGeneration = await captureSourceGeneration(projectId);
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
            const filePath = await authorizeClaudeFilePath({
                projectsRoot: authorizedProjectsRoot.projectsRoot,
                filePath: join(projectPath, `${remoteSessionId}.jsonl`),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (!filePath) continue;
            if (selected.length >= limit) {
                hasMore = true;
                break;
            }
            selected.push({
                remoteSessionId,
                projectId,
                filePath,
                updatedAtMs: 0,
                traversalKey,
                scanPosition: { projectId, sessionEntryOffset },
                sourceGeneration: projectSourceGeneration,
            });
            nextScanPoint = {
                scanPosition: { projectId, sessionEntryOffset },
                sourceGeneration: projectSourceGeneration,
            };
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
    for (const [resumeKey, captured] of capturedGenerations) {
        const current = await resolveResumeProjectGeneration(
            projectsDir,
            resumeKey === '' ? null : resumeKey,
            params.signal,
        );
        if (current !== captured) {
            throw new ClaudeCandidateSourceChangedError(
                'Claude candidate source changed during the bounded scan chunk.',
            );
        }
    }
    return {
        entries,
        hasMore,
        sourceGeneration,
        nextScanPoint: hasMore ? nextScanPoint : null,
        scanned: selected.length,
    };
}

function resolvePreferredProjectId(source: ClaudeExternalSessionSource): string | null {
    if (source.kind !== 'claudeConfig') return null;
    const projectId = typeof source.projectId === 'string' ? source.projectId.trim() : '';
    return isSafeClaudeJsonlPathSegment(projectId) ? projectId : null;
}

/**
 * An unqualified Claude reference must resolve the same private candidate that
 * the host Browse index presents first. The shared precedence owner carries the
 * opaque linkData tie-break; this leaf supplies only Claude's project identity.
 */
function compareClaudeJsonlSessionPrecedence(
    left: DiscoveredClaudeJsonlSession,
    right: DiscoveredClaudeJsonlSession,
): number {
    return compareExternalSessionCandidatePrecedence(
        {
            remoteSessionId: left.remoteSessionId,
            updatedAtMs: left.updatedAtMs,
            linkData: { projectId: left.projectId },
        },
        {
            remoteSessionId: right.remoteSessionId,
            updatedAtMs: right.updatedAtMs,
            linkData: { projectId: right.projectId },
        },
    );
}

/**
 * Canonicalizes the admitted Claude config root before resolving its `projects`
 * child. This preserves an intentionally symlinked configured root while
 * rejecting a symlink planted below it that redirects `projects` elsewhere.
 */
async function resolveAuthorizedClaudeProjectsRoot(params: Readonly<{
    configDir: string;
    signal?: AbortSignal;
}>): Promise<AuthorizedClaudeProjectsRoot | null> {
    const configRoot = await realpath(params.configDir).catch(() => null);
    throwIfAborted(params.signal);
    if (!configRoot) return null;

    const projectsRoot = await realpath(join(configRoot, 'projects')).catch(() => null);
    throwIfAborted(params.signal);
    if (
        !projectsRoot
        || projectsRoot === configRoot
        || !isCanonicalAbsolutePathInsideRoot(configRoot, projectsRoot)
    ) {
        return null;
    }
    const directory = await stat(projectsRoot).catch(() => null);
    throwIfAborted(params.signal);
    return directory?.isDirectory() ? { projectsRoot } : null;
}

/**
 * The single physical authorization decision for selected Claude session files.
 * A name inside the admitted config root is not proof that the bytes are: a
 * symlink placed there points anywhere on the machine, and `stat` follows it.
 * `lstat` rejects a symlink at the file name itself; `realpath` resolves any
 * ancestor; containment is then decided against the already-admitted physical
 * projects root.
 */
export async function authorizeClaudeFilePath(params: Readonly<{
    projectsRoot: string;
    filePath: string;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const link = await lstat(params.filePath).catch(() => null);
    throwIfAborted(params.signal);
    if (!link?.isFile()) return null;
    const physicalPath = await realpath(params.filePath).catch(() => null);
    throwIfAborted(params.signal);
    if (!physicalPath) return null;
    return isCanonicalAbsolutePathInsideRoot(params.projectsRoot, physicalPath)
        ? physicalPath
        : null;
}

export async function resolveClaudeJsonlSessionFile(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    signal?: AbortSignal;
}>): Promise<ResolvedClaudeJsonlSessionFile | null> {
    throwIfAborted(params.signal);
    const remoteSessionId = String(params.remoteSessionId ?? '').trim();
    if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) return null;

    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const authorizedProjectsRoot = await resolveAuthorizedClaudeProjectsRoot({
        configDir,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!authorizedProjectsRoot) return null;
    const projectsDir = authorizedProjectsRoot.projectsRoot;
    const preferredProjectId = resolvePreferredProjectId(params.source);

    const resolveInProject = async (projectId: string): Promise<ResolvedClaudeJsonlSessionFile | null> => {
        if (!isSafeClaudeJsonlPathSegment(projectId)) return null;
        const authorizedPath = await authorizeClaudeFilePath({
            projectsRoot: authorizedProjectsRoot.projectsRoot,
            filePath: join(projectsDir, projectId, `${remoteSessionId}.jsonl`),
            ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!authorizedPath) return null;
        return {
            filePath: authorizedPath,
            fileRelPath: join('projects', projectId, `${remoteSessionId}.jsonl`).replace(/\\/g, '/'),
            projectId,
        };
    };

    if (preferredProjectId) {
        return await resolveInProject(preferredProjectId);
    }

    const projectEntries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    let newest: Readonly<{
        resolved: ResolvedClaudeJsonlSessionFile;
        candidate: DiscoveredClaudeJsonlSession;
    }> | null = null;
    for (const entry of projectEntries) {
        throwIfAborted(params.signal);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const projectId = typeof entry.name === 'string' ? entry.name : String(entry.name);
        const resolved = await resolveInProject(projectId);
        if (!resolved) continue;
        try {
            const file = await stat(resolved.filePath);
            throwIfAborted(params.signal);
            const candidate = {
                remoteSessionId,
                projectId,
                filePath: resolved.filePath,
                updatedAtMs: Math.trunc(file.mtimeMs),
            } satisfies DiscoveredClaudeJsonlSession;
            if (!newest || compareClaudeJsonlSessionPrecedence(candidate, newest.candidate) < 0) {
                newest = { resolved, candidate };
            }
        } catch {
            throwIfAborted(params.signal);
            continue;
        }
    }
    return newest?.resolved ?? null;
}

export async function findClaudeJsonlSessionsById(params: Readonly<{
    source: ClaudeExternalSessionSource;
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
    const authorizedProjectsRoot = await resolveAuthorizedClaudeProjectsRoot({
        configDir,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!authorizedProjectsRoot) {
        return {
            matches: [],
            sourceGeneration: createHash('sha256').update('empty').digest('base64url'),
        };
    }
    const projectsDir = authorizedProjectsRoot.projectsRoot;
    const preferredProjectId = resolvePreferredProjectId(params.source);
    const projectIds = preferredProjectId
        ? [preferredProjectId]
        : (await readdir(projectsDir, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
            .map((entry) => String(entry.name))
            .filter((projectId) => isSafeClaudeJsonlPathSegment(projectId))
            .sort((left, right) => left.localeCompare(right));
    const candidateSourceGeneration = projectIds.length > 0
        ? resolveProjectListGeneration(projectIds)
        : createHash('sha256').update('empty').digest('base64url');
    const generation = createHash('sha256');
    generation.update(`${candidateSourceGeneration}\n${remoteSessionId}\n`);

    const resolveInProject = async (projectId: string): Promise<DiscoveredClaudeJsonlSession | null> => {
        const authorizedPath = await authorizeClaudeFilePath({
            projectsRoot: authorizedProjectsRoot.projectsRoot,
            filePath: join(projectsDir, projectId, `${remoteSessionId}.jsonl`),
            ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!authorizedPath) {
            generation.update(`${projectId}:missing\n`);
            return null;
        }
        try {
            const file = await stat(authorizedPath, { bigint: true });
            throwIfAborted(params.signal);
            if (!file.isFile()) {
                generation.update(`${projectId}:missing\n`);
                return null;
            }
            generation.update(
                `${projectId}:${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}\n`,
            );
            return {
                remoteSessionId,
                projectId,
                filePath: authorizedPath,
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
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
}>): Promise<readonly DiscoveredClaudeJsonlSession[]> {
    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const authorizedProjectsRoot = await resolveAuthorizedClaudeProjectsRoot({ configDir });
    if (!authorizedProjectsRoot) return [];
    const projectsDir = authorizedProjectsRoot.projectsRoot;
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
            const filePath = await authorizeClaudeFilePath({
                projectsRoot: authorizedProjectsRoot.projectsRoot,
                filePath: join(projectPath, name),
            });
            if (!filePath) continue;
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
