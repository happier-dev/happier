import { createHash } from 'node:crypto';
import { lstat, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { compareExternalSessionCandidatePrecedence } from '@happier-dev/plugin-sdk/sessions/external';

import { readClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';
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
    /** Last fully visited recent-first file, independent of directory offsets. */
    recent?: Readonly<{ updatedAtMs: number; remoteSessionId: string }>;
}>;

export type ClaudeJsonlSessionIdSnapshot = Readonly<{
    matches: readonly DiscoveredClaudeJsonlSession[];
    sourceGeneration: string;
}>;

type AuthorizedClaudeProjectsRoot = Readonly<{
    projectsRoot: string;
}>;

type ClaudeTranscriptPathKind = 'claude_projects_dir' | 'session_dir' | 'transcript_file';

export type ClaudeTranscriptLookupFailure = Readonly<{
    code: 'transcript_missing' | 'root_mismatch' | 'permission_denied' | 'not_directory'
        | 'not_regular_file' | 'invalid_session_id' | 'lookup_failed';
    pathKind: ClaudeTranscriptPathKind;
}>;

export function classifyClaudeTranscriptLookupError(error: unknown, pathKind: ClaudeTranscriptPathKind): ClaudeTranscriptLookupFailure {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    switch (code) {
        case 'ENOENT': return { code: 'transcript_missing', pathKind };
        case 'EACCES':
        case 'EPERM': return { code: 'permission_denied', pathKind };
        case 'ENOTDIR': return { code: 'not_directory', pathKind };
        default: return { code: 'lookup_failed', pathKind };
    }
}

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
 * Reads one deterministic lexical metadata chunk, statting only that chunk.
 * Content search orders the native file metadata set by recency
 * before reading bodies, so a large old project cannot hide recent work.
 */
export async function pageClaudeJsonlSessionFiles(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    afterTraversalKey?: string | null;
    scanPosition?: ClaudeJsonlSessionScanPosition | null;
    skip?: number;
    limit: number;
    order?: 'recent';
    updatedAfterMs?: number;
    signal?: AbortSignal;
    recentWindow?: Readonly<{ startedAtMs: number; changedBeforeMs?: number }>;
    unfinished?: ClaudeJsonlSessionScanPosition;
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
    const sourceGeneration = params.order === 'recent' ? '' : await captureSourceGeneration(params.scanPosition?.projectId ?? null);
    const selected: ClaudeJsonlSessionTraversalEntry[] = [];
    let skipped = 0;
    let hasMore = false;
    let nextScanPoint: ClaudeJsonlSessionScanPoint | null = null;
    for (const projectId of projectIds) {
        throwIfAborted(params.signal);
        if (params.order !== 'recent' && params.scanPosition && projectId.localeCompare(params.scanPosition.projectId) < 0) {
            continue;
        }
        const projectPath = join(projectsDir, projectId);
        const projectSourceGeneration = params.order === 'recent' ? '' : await captureSourceGeneration(projectId);
        // Content pages relist native names; only metadata cursors use raw directory offsets.
        const directory = params.order === 'recent'
            ? await readdir(projectPath, { withFileTypes: true }).catch(() => null)
            : await opendir(projectPath).catch(() => null);
        if (!directory) continue;
        let sessionEntryOffset = 0;
        for await (const entry of directory) {
            sessionEntryOffset += 1;
            throwIfAborted(params.signal);
            if (
                params.scanPosition
                && params.order !== 'recent'
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
            if (params.order !== 'recent' && !params.scanPosition && traversalKey.localeCompare(afterTraversalKey) <= 0) continue;
            if (params.order !== 'recent' && skipped < skip) {
                skipped += 1;
                continue;
            }
            const filePath = await authorizeClaudeFilePath({
                projectsRoot: authorizedProjectsRoot.projectsRoot,
                filePath: join(projectPath, `${remoteSessionId}.jsonl`),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (!filePath) continue;
            // A native inventory's history window is known before optional
            // title/body reads and before filling its candidate page.
            let updatedAtMs = 0;
            if (params.updatedAfterMs !== undefined) {
                const file = await stat(filePath).catch(() => null);
                throwIfAborted(params.signal);
                if (!file?.isFile() || file.mtimeMs < params.updatedAfterMs) continue;
                updatedAtMs = Math.trunc(file.mtimeMs);
            }
            if (params.order !== 'recent' && selected.length >= limit) {
                hasMore = true;
                break;
            }
            selected.push({
                remoteSessionId,
                projectId,
                filePath,
                updatedAtMs,
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
        if (params.updatedAfterMs !== undefined) {
            entries.push({ ...entry, ...(params.order === 'recent' ? { scanPosition: { ...entry.scanPosition,
                recent: { updatedAtMs: entry.updatedAtMs, remoteSessionId: entry.remoteSessionId } } } : {}) });
            continue;
        }
        try {
            const file = await stat(entry.filePath);
            if (!file.isFile()) continue;
            const updatedAtMs = Math.trunc(file.mtimeMs);
            entries.push({
                ...entry,
                updatedAtMs,
                ...(params.order === 'recent' ? { scanPosition: { ...entry.scanPosition,
                    recent: { updatedAtMs, remoteSessionId: entry.remoteSessionId } } } : {}),
            });
        } catch {
            throwIfAborted(params.signal);
        }
    }
    throwIfAborted(params.signal);
    for (const [resumeKey, captured] of params.order === 'recent' ? [] : capturedGenerations) {
        const current = await resolveResumeProjectGeneration(
            projectsDir,
            resumeKey === '' ? null : resumeKey,
            params.signal,
        );
        if (current !== captured) {
            throw new ClaudeCandidateSourceChangedError(
                'external_sessions_frontier_anchor',
            );
        }
    }
    if (params.order === 'recent') {
        const position = params.scanPosition;
        const boundary = position?.recent ? {
            projectId: position.projectId, remoteSessionId: position.recent.remoteSessionId,
            updatedAtMs: position.recent.updatedAtMs,
        } : null;
        const window = params.recentWindow;
        const pending = params.unfinished;
        const unfinished = pending?.recent ? entries.find(entry => entry.projectId === pending.projectId
            && entry.remoteSessionId === pending.recent?.remoteSessionId) : undefined;
        if (pending && !unfinished) {
            throw new ClaudeCandidateSourceChangedError('external_sessions_unfinished_file_missing');
        }
        const remaining = entries.sort(compareClaudeJsonlSessionPrecedence).filter(entry => {
            if (unfinished === entry) return false;
            if (window && (window.changedBeforeMs === undefined
                ? entry.updatedAtMs > window.startedAtMs
                : entry.updatedAtMs <= window.startedAtMs || entry.updatedAtMs > window.changedBeforeMs)) return false;
            return !boundary || compareClaudeJsonlSessionPrecedence(entry, boundary) > 0;
        });
        // The decoder revalidates the unfinished file's full identity. Keep its
        // captured position until that one file is fully visited, even after a write.
        if (unfinished && pending) remaining.unshift({ ...unfinished, scanPosition: pending });
        const skippedRemaining = remaining.slice(skip);
        const page = skippedRemaining.slice(0, limit);
        const last = page.at(-1);
        return {
            entries: page,
            hasMore: skippedRemaining.length > page.length,
            sourceGeneration: '',
            nextScanPoint: skippedRemaining.length > page.length && last
                ? { scanPosition: last.scanPosition, sourceGeneration: last.sourceGeneration } : null,
            scanned: page.length,
        };
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
    left: Pick<DiscoveredClaudeJsonlSession, 'projectId' | 'remoteSessionId' | 'updatedAtMs'>,
    right: Pick<DiscoveredClaudeJsonlSession, 'projectId' | 'remoteSessionId' | 'updatedAtMs'>,
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
 * The admitted config home owns its native `projects` entry. Connected-account
 * shared state deliberately links that entry to the native account's projects.
 * Resolve that storage root first; every project and file must remain physically
 * inside it, regardless of whether the config home or state entry is linked.
 */
async function resolveAuthorizedClaudeProjectsRoot(params: Readonly<{
    configDir: string;
    signal?: AbortSignal;
}>): Promise<AuthorizedClaudeProjectsRoot | null> {
    const result = await inspectClaudeProjectsRoot(params);
    return 'projectsRoot' in result ? result : null;
}

async function inspectClaudeProjectsRoot(params: Readonly<{
    configDir: string;
    signal?: AbortSignal;
}>): Promise<AuthorizedClaudeProjectsRoot | ClaudeTranscriptLookupFailure> {
    const pathKind = 'claude_projects_dir';
    try {
        const configRoot = await realpath(params.configDir);
        throwIfAborted(params.signal);
        const projectsRoot = await realpath(join(configRoot, 'projects'));
        throwIfAborted(params.signal);
        if (projectsRoot === configRoot) return { code: 'root_mismatch', pathKind };
        const directory = await stat(projectsRoot);
        throwIfAborted(params.signal);
        return directory.isDirectory() ? { projectsRoot } : { code: 'not_directory', pathKind };
    } catch (error) {
        throwIfAborted(params.signal);
        return classifyClaudeTranscriptLookupError(error, pathKind);
    }
}

/**
 * The single physical authorization decision for selected Claude session files.
 * A name inside the admitted config root is not proof that the bytes are: a
 * symlink placed there points anywhere on the machine, and `stat` follows it.
 * `lstat` rejects a symlink at the file name itself; `realpath` resolves any
 * ancestor; containment is then decided against the already-admitted physical
 * projects root.
 */
type ClaudeFilePathAuthorization = Readonly<{
    projectsRoot: string;
    filePath: string;
    signal?: AbortSignal;
}>;

async function inspectClaudeFilePath(params: ClaudeFilePathAuthorization): Promise<string | ClaudeTranscriptLookupFailure> {
    // Exact lookup and directory enumeration must agree: a project alias is
    // never a second native identity, even when its target stays in this root.
    let pathKind: ClaudeTranscriptPathKind = 'session_dir';
    try {
        const project = await lstat(dirname(params.filePath));
        throwIfAborted(params.signal);
        if (project.isSymbolicLink()) return { code: 'root_mismatch', pathKind };
        if (!project.isDirectory()) return { code: 'not_directory', pathKind };

        pathKind = 'transcript_file';
        const file = await lstat(params.filePath);
        throwIfAborted(params.signal);
        if (file.isSymbolicLink()) return { code: 'root_mismatch', pathKind };
        if (!file.isFile()) return { code: 'not_regular_file', pathKind };
        const physicalPath = await realpath(params.filePath);
        throwIfAborted(params.signal);
        return isCanonicalAbsolutePathInsideRoot(params.projectsRoot, physicalPath)
            ? physicalPath
            : { code: 'root_mismatch', pathKind };
    } catch (error) {
        throwIfAborted(params.signal);
        return classifyClaudeTranscriptLookupError(error, pathKind);
    }
}

export async function authorizeClaudeFilePath(params: ClaudeFilePathAuthorization): Promise<string | null> {
    const result = await inspectClaudeFilePath(params);
    return typeof result === 'string' ? result : null;
}

type ClaudeSessionFileLookup = Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    signal?: AbortSignal;
}>;

export async function resolveClaudeJsonlSessionFile(params: ClaudeSessionFileLookup): Promise<ResolvedClaudeJsonlSessionFile | null> {
    const result = await lookupClaudeJsonlSessionFile(params);
    return 'filePath' in result ? result : null;
}

export async function lookupClaudeJsonlSessionFile(params: ClaudeSessionFileLookup): Promise<ResolvedClaudeJsonlSessionFile | ClaudeTranscriptLookupFailure> {
    throwIfAborted(params.signal);
    const remoteSessionId = readClaudeProviderIdentityValue(params.remoteSessionId) ?? '';
    if (!isSafeClaudeJsonlPathSegment(remoteSessionId)) return { code: 'invalid_session_id', pathKind: 'transcript_file' };

    const configDir = resolveClaudeConfigDir({ source: params.source, env: params.env });
    const authorizedProjectsRoot = await inspectClaudeProjectsRoot({
        configDir,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if ('code' in authorizedProjectsRoot) return authorizedProjectsRoot;
    const projectsDir = authorizedProjectsRoot.projectsRoot;
    const preferredProjectId = resolvePreferredProjectId(params.source);

    const resolveInProject = async (projectId: string): Promise<ResolvedClaudeJsonlSessionFile | ClaudeTranscriptLookupFailure> => {
        const authorizedPath = await inspectClaudeFilePath({
            projectsRoot: projectsDir,
            filePath: join(projectsDir, projectId, `${remoteSessionId}.jsonl`),
            ...(params.signal ? { signal: params.signal } : {}),
        });
        if (typeof authorizedPath !== 'string') return authorizedPath;
        return {
            filePath: authorizedPath,
            fileRelPath: join('projects', projectId, `${remoteSessionId}.jsonl`).replace(/\\/g, '/'),
            projectId,
        };
    };

    if (preferredProjectId) {
        return await resolveInProject(preferredProjectId);
    }

    let projectEntries;
    try {
        projectEntries = await readdir(projectsDir, { withFileTypes: true });
    } catch (error) {
        throwIfAborted(params.signal);
        return classifyClaudeTranscriptLookupError(error, 'claude_projects_dir');
    }
    let failure: ClaudeTranscriptLookupFailure | undefined;
    let newest: Readonly<{
        resolved: ResolvedClaudeJsonlSessionFile;
        candidate: DiscoveredClaudeJsonlSession;
    }> | null = null;
    for (const entry of projectEntries) {
        throwIfAborted(params.signal);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const projectId = typeof entry.name === 'string' ? entry.name : String(entry.name);
        if (!isSafeClaudeJsonlPathSegment(projectId)) continue;
        const resolved = await resolveInProject(projectId);
        if ('code' in resolved) {
            if (resolved.code !== 'transcript_missing') failure ??= resolved;
            continue;
        }
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
        } catch (error) {
            throwIfAborted(params.signal);
            const candidateFailure = classifyClaudeTranscriptLookupError(error, 'transcript_file');
            if (candidateFailure.code !== 'transcript_missing') failure ??= candidateFailure;
        }
    }
    return newest?.resolved ?? failure ?? { code: 'transcript_missing', pathKind: 'transcript_file' };
}

export async function findClaudeJsonlSessionsById(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    signal?: AbortSignal;
}>): Promise<ClaudeJsonlSessionIdSnapshot> {
    throwIfAborted(params.signal);
    const remoteSessionId = readClaudeProviderIdentityValue(params.remoteSessionId) ?? '';
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
