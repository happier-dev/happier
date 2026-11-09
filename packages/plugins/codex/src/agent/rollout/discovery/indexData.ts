import {
    closeSync,
    openSync,
    readSync,
    type Dirent,
} from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, posix, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
    throwIfCodexExternalSessionInvocationStopped,
    type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import { readExactCodexProviderSessionId } from '../../../protocol/runtimeDescriptorV1.js';

export type CodexSessionMetaPayload = {
    id?: string;
    session_id?: string;
    timestamp?: string;
    cwd?: string;
    [key: string]: unknown;
};

export type CodexRolloutCandidate = {
    filePath: string;
    sessionMeta: CodexSessionMetaPayload;
};

type ScanOptions = {
    sessionsRootDir: string;
    scanLimit: number;
    maxDepth?: number;
};

const CODEX_SESSION_META_CLOCK_SKEW_MS = 2_000;

const CODEX_ROLLOUT_SUFFIX_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl(?:\.zst)?$/i;
const CODEX_ROLLOUT_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;

export type CodexRolloutFilename = Readonly<{
    sessionId: string;
    threadId?: string;
    turnId?: string;
}>;

/** Physical rollout formats supported by Codex, including legacy noncanonical names. */
export function isCodexRolloutFilePath(path: string): boolean {
    return /\.jsonl(?:\.zst)?$/i.test(path);
}

/** Codex indexes the logical plain path even while the physical rollout is compressed. */
export function resolveCodexLogicalRolloutPath(path: string): string {
    return /\.jsonl\.zst$/i.test(path) ? path.slice(0, -4) : path;
}

/** Leave decoding and append-time materialization to Codex's native rollout owner. */
export async function resolveExistingCodexRolloutPath(path: string): Promise<string | null> {
    const plainPath = resolveCodexLogicalRolloutPath(path);
    const candidates = isCodexRolloutFilePath(path) ? [plainPath, `${plainPath}.zst`] : [path];
    for (const candidate of candidates) {
        try {
            if ((await stat(candidate)).isFile()) return candidate;
        } catch (error) {
            if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
            throw error;
        }
    }
    return null;
}

/** Matches rollout identities exactly, with case folding only for UUIDs. */
export function isMatchingCodexRolloutIdentity(candidateId: string | undefined, requestedId: string): boolean {
    const uuid = (value: string | undefined): value is string => typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    return candidateId === requestedId
        || (uuid(candidateId) && uuid(requestedId) && candidateId.toLowerCase() === requestedId.toLowerCase());
}

/** Parses a rollout suffix while identifying the thread represented by a composite continuation. */
export function parseCodexRolloutFilename(filePath: string): CodexRolloutFilename | null {
    const name = filePath.split(/[/\\\\]/).pop() ?? '';
    const suffix = CODEX_ROLLOUT_SUFFIX_PATTERN.exec(name)?.[1];
    if (!suffix) return null;
    const ids = CODEX_ROLLOUT_ID_PATTERN.exec(suffix);
    return {
        sessionId: suffix,
        ...(ids?.[1] ? { threadId: ids[1] } : {}),
        ...(ids?.[2] ? { turnId: ids[2] } : {}),
    };
}

export function parseCodexRolloutSessionIdFromFilename(filePath: string): string | null {
    // A filename is not a byte-exact identity source: Windows strips trailing
    // spaces and dots from names, so this stays a trimmed best-effort fast path.
    // `session_meta.payload.id` is the authoritative id and is read exactly.
    const sessionId = parseCodexRolloutFilename(filePath)?.sessionId.trim() ?? '';
    return sessionId || null;
}

function parseResumeIdFromRolloutFilename(filePath: string): string | null {
    const name = basename(filePath);
    return parseCodexRolloutFilename(filePath)?.threadId ?? null;
}

function parseRolloutTimestampFromFilename(filePath: string): number | null {
    const name = basename(filePath);
    const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(name);
    if (!match) return null;
    const compact = match[1];
    const isoLike = compact.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const ms = Date.parse(`${isoLike}Z`);
    return Number.isFinite(ms) ? ms : null;
}

function parseSessionMetaTimestampMs(sessionMeta: CodexSessionMetaPayload): number | null {
    const raw = typeof sessionMeta.timestamp === 'string' ? sessionMeta.timestamp : null;
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
}

function isSessionMetaFreshForStart(opts: { sessionMeta: CodexSessionMetaPayload; startedAtMs: number }): boolean {
    const ts = parseSessionMetaTimestampMs(opts.sessionMeta);
    if (ts === null) return false;
    return ts >= opts.startedAtMs - CODEX_SESSION_META_CLOCK_SKEW_MS;
}

function isSubagentRollout(sessionMeta: CodexSessionMetaPayload): boolean {
    const source = sessionMeta.source;
    return Boolean(
        source
        && typeof source === 'object'
        && !Array.isArray(source)
        && Object.prototype.hasOwnProperty.call(source, 'subagent'),
    );
}

function normalizeCwdForComparison(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const pathApi = process.platform === 'win32' ? win32 : posix;
    const platformPath = process.platform === 'win32'
        ? value.trim().replaceAll('/', '\\')
        : value.trim().replaceAll('\\', '/');
    const normalized = pathApi.resolve(platformPath);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function resolveCwdForComparison(value: unknown): Promise<string | null> {
    const normalized = normalizeCwdForComparison(value);
    if (!normalized) return null;
    const physicalPath = await realpath(normalized).catch(() => null);
    return physicalPath ? normalizeCwdForComparison(physicalPath) : normalized;
}

async function isOwnedFreshRootRollout(opts: Readonly<{
    sessionMeta: CodexSessionMetaPayload;
    startedAtMs: number;
    expectedCwd: string | null;
}>): Promise<boolean> {
    if (!isSessionMetaFreshForStart({
        sessionMeta: opts.sessionMeta,
        startedAtMs: opts.startedAtMs,
    })) {
        return false;
    }
    if (isSubagentRollout(opts.sessionMeta) || !opts.expectedCwd) return false;
    return await resolveCwdForComparison(opts.sessionMeta.cwd) === opts.expectedCwd;
}

type RolloutFileEntry = Readonly<{ filePath: string; mtimeMs: number }>;

async function collectRolloutFiles(opts: ScanOptions): Promise<RolloutFileEntry[]> {
    const results: string[] = [];
    const maxDepth = Math.max(0, typeof opts.maxDepth === 'number' ? opts.maxDepth : 10);
    const scanLimit = Math.max(0, opts.scanLimit);

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth >= maxDepth || results.length >= scanLimit) return;

        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((left, right) => String(right.name).localeCompare(String(left.name)));
        for (const entry of entries) {
            if (results.length >= scanLimit) return;
            const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
            const full = join(dir, name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                await walk(full, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
            results.push(full);
        }
    }

    await walk(opts.sessionsRootDir, 0);

    // Codex date-partitions rollouts under zero-padded YYYY/MM/DD directories and timestamped filenames.
    // Traverse those names newest-first and enforce scanLimit before statting. A full stat-and-sort of a
    // long-lived Codex home can otherwise delay terminal transcript attachment for minutes.
    const withTime: Array<{ filePath: string; sortMs: number; mtimeMs: number }> = [];
    for (const filePath of results) {
        try {
            const s = await stat(filePath);
            const fromName = parseRolloutTimestampFromFilename(filePath);
            const fromBirth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 ? s.birthtimeMs : null;
            const sortMs = Math.max(fromName ?? 0, fromBirth ?? 0, s.mtimeMs);
            withTime.push({ filePath, sortMs, mtimeMs: s.mtimeMs });
        } catch {
            // ignore unreadable files
        }
    }
    withTime.sort((a, b) => b.sortMs - a.sortMs || b.mtimeMs - a.mtimeMs);
    return withTime.map((x) => ({ filePath: x.filePath, mtimeMs: x.mtimeMs }));
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readFirstLineFromHandle(
    fh: FileHandle,
    bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
    const maxProbeBytes = 64 * 1024;
    // Use the existing probe allowance in one I/O. Long native instruction
    // headers otherwise multiply filesystem round trips across the home scan.
    const chunkBytes = maxProbeBytes;
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let readOffset = 0;
    let text = '';
    let sawEof = false;

    while (readOffset < maxProbeBytes) {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const bytesToRead = Math.min(chunk.byteLength, maxProbeBytes - readOffset);
        const res = await fh.read(chunk, 0, bytesToRead, readOffset);
        throwIfCodexExternalSessionInvocationStopped(bounds);
        if (res.bytesRead <= 0) {
            sawEof = true;
            break;
        }
        readOffset += res.bytesRead;
        text += decoder.write(chunk.subarray(0, res.bytesRead));
        const idx = text.indexOf('\n');
        if (idx !== -1) {
            const line = text.slice(0, idx).trim();
            return line.length > 0 ? line : null;
        }
        if (res.bytesRead < bytesToRead) {
            sawEof = true;
            break;
        }
    }

    text += decoder.end();
    const idx = text.indexOf('\n');
    if (idx !== -1) {
        const line = text.slice(0, idx).trim();
        return line.length > 0 ? line : null;
    }
    if (!sawEof && readOffset >= maxProbeBytes) return null;
    const line = text.trim();
    return line.length > 0 ? line : null;
}

function readFirstLineSync(filePath: string): string | null {
    const maxProbeBytes = 64 * 1024;
    const chunkBytes = 4 * 1024;
    let fd: number | null = null;
    try {
        fd = openSync(filePath, 'r');
        const decoder = new StringDecoder('utf8');
        const chunk = Buffer.allocUnsafe(chunkBytes);
        let readOffset = 0;
        let text = '';
        let sawEof = false;

        while (readOffset < maxProbeBytes) {
            const bytesToRead = Math.min(
                chunk.byteLength,
                maxProbeBytes - readOffset,
            );
            const bytesRead = readSync(
                fd,
                chunk,
                0,
                bytesToRead,
                readOffset,
            );
            if (bytesRead <= 0) {
                sawEof = true;
                break;
            }
            readOffset += bytesRead;
            text += decoder.write(chunk.subarray(0, bytesRead));
            const index = text.indexOf('\n');
            if (index !== -1) {
                const line = text.slice(0, index).trim();
                return line.length > 0 ? line : null;
            }
            if (bytesRead < bytesToRead) {
                sawEof = true;
                break;
            }
        }

        text += decoder.end();
        const index = text.indexOf('\n');
        if (index !== -1) {
            const line = text.slice(0, index).trim();
            return line.length > 0 ? line : null;
        }
        if (!sawEof && readOffset >= maxProbeBytes) return null;
        const line = text.trim();
        return line.length > 0 ? line : null;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Ignore close failures after a best-effort metadata probe.
            }
        }
    }
}

export function parseCodexSessionMetaLine(
    line: string,
): CodexSessionMetaPayload | null {
    try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const envelope = parsed as Record<string, unknown>;
        if (envelope.type !== 'session_meta') return null;
        const payload = envelope.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        return payload as CodexSessionMetaPayload;
    } catch {
        return null;
    }
}

/**
 * Keeps only the `session_meta` fields this plugin reads. Line 1 also carries the
 * full base instructions (~20 KB), which nothing here uses and which must not be
 * retained.
 */
function retainSessionMetaFields(payload: CodexSessionMetaPayload | null): CodexSessionMetaPayload | null {
    if (!payload) return null;
    return Object.freeze({
        ...(payload.id !== undefined ? { id: payload.id } : {}),
        ...(payload.session_id !== undefined ? { session_id: payload.session_id } : {}),
        ...(payload.timestamp !== undefined ? { timestamp: payload.timestamp } : {}),
        ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
        ...(payload.source !== undefined ? { source: payload.source } : {}),
        ...(payload.history_mode !== undefined ? { history_mode: payload.history_mode } : {}),
        ...(payload.history_base !== undefined ? { history_base: payload.history_base } : {}),
    });
}

/**
 * Codex writes `session_meta` once, as line 1, when it creates a rollout; later
 * turns normally append. Re-reading and parsing that line for every rollout on every
 * inventory was the dominant per-call cost of paging a long-lived Codex session
 * (thousands of files), so a parsed line is remembered per path and trusted only
 * while native identity, size and modification/change times remain unchanged.
 * A same-inode rewrite must refresh membership too. A line that does not parse
 * yet — a rollout still being created — is never remembered.
 */
export type CodexSessionMetaCache = Map<string, Readonly<{
    fileVersion: string;
    sessionMeta: CodexSessionMetaPayload;
}>>;

function sessionMetaFileVersion(metadata: Readonly<{ dev: number; ino: number; birthtimeMs: number; size: number; mtimeMs: number; ctimeMs: number }>): string {
    return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}

export async function readCodexSessionMetaFromRollout(
    filePath: string,
    bounds: CodexExternalSessionInvocationBounds = {},
): Promise<CodexSessionMetaPayload | null> {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    if (bounds.preparation) return await bounds.preparation.readSessionIdentity(filePath,
        () => readCodexSessionMetaFromRollout(filePath, { ...bounds, preparation: undefined }));
    try {
        const current = await stat(filePath);
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const remembered = bounds.sessionMetaCache?.get(filePath);
        if (remembered?.fileVersion === sessionMetaFileVersion(current)) return remembered.sessionMeta;
        const fh = await open(filePath, 'r');
        try {
            throwIfCodexExternalSessionInvocationStopped(bounds);
            const metadata = await fh.stat();
            const line = await readFirstLineFromHandle(fh, bounds);
            throwIfCodexExternalSessionInvocationStopped(bounds);
            const sessionMeta = line ? retainSessionMetaFields(parseCodexSessionMetaLine(line)) : null;
            if (sessionMeta) {
                bounds.sessionMetaCache?.set(filePath, { fileVersion: sessionMetaFileVersion(metadata), sessionMeta });
            } else {
                bounds.sessionMetaCache?.delete(filePath);
            }
            return sessionMeta;
        } finally {
            await fh.close();
        }
    } catch {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        bounds.sessionMetaCache?.delete(filePath);
        return null;
    }
}

export function readCodexSessionMetaFromRolloutSync(
    filePath: string,
): CodexSessionMetaPayload | null {
    const line = readFirstLineSync(filePath);
    return line ? parseCodexSessionMetaLine(line) : null;
}

export function scoreCodexRolloutCandidate(opts: {
    sessionMeta: CodexSessionMetaPayload;
    startedAtMs: number;
    cwd: string;
}): number {
    let score = 0;

    const ts = parseSessionMetaTimestampMs(opts.sessionMeta);
    if (ts !== null) {
        const deltaMs = ts - opts.startedAtMs;
        if (deltaMs < -CODEX_SESSION_META_CLOCK_SKEW_MS) {
            // If a session started before this launcher, it is extremely likely to be unrelated.
            score -= 1_000;
        } else {
            const diffMs = Math.abs(deltaMs);
            if (diffMs <= 10_000) score += 100;
            else if (diffMs <= 60_000) score += 50;
            else if (diffMs <= 5 * 60_000) score += 10;
        }
    } else {
        score -= 100;
    }

    const expectedCwd = normalizeCwdForComparison(opts.cwd);
    const candidateCwd = normalizeCwdForComparison(opts.sessionMeta.cwd);
    if (expectedCwd !== null && candidateCwd === expectedCwd) {
        score += 20;
    }

    return score;
}

export async function discoverCodexRolloutFileOnce(opts: {
    sessionsRootDir: string;
    startedAtMs: number;
    cwd: string;
    resumeId?: string | null;
    scanLimit: number;
}): Promise<CodexRolloutCandidate | null> {
    // Codex minted this id; it is matched against rollout files verbatim.
    const resumeId = readExactCodexProviderSessionId(opts.resumeId);

    // Fast-path: filename fragment match.
    if (resumeId) {
        const all = await collectRolloutFiles({ sessionsRootDir: opts.sessionsRootDir, scanLimit: opts.scanLimit });
        const matches = all.filter((p) => p.filePath.includes(resumeId));
        if (matches.length > 0) {
            // collectRolloutFiles returns newest-first by a stable creation-ish timestamp.
            for (const entry of matches) {
                const sessionMeta = await readCodexSessionMetaFromRollout(entry.filePath);
                if (sessionMeta) return { filePath: entry.filePath, sessionMeta };
                const idFromName = parseResumeIdFromRolloutFilename(entry.filePath);
                if (idFromName) {
                    return {
                        filePath: entry.filePath,
                        sessionMeta: {
                            id: idFromName,
                            timestamp: new Date(entry.mtimeMs).toISOString(),
                            cwd: opts.cwd,
                        },
                    };
                }
            }
        }
    }

    const files = await collectRolloutFiles({ sessionsRootDir: opts.sessionsRootDir, scanLimit: opts.scanLimit });
    const scored: Array<{ filePath: string; mtimeMs: number; sessionMeta: CodexSessionMetaPayload; score: number }> = [];
    for (const entry of files) {
        const sessionMeta = await readCodexSessionMetaFromRollout(entry.filePath);
        if (!sessionMeta) {
            continue;
        }
        const score = scoreCodexRolloutCandidate({
            sessionMeta,
            startedAtMs: opts.startedAtMs,
            cwd: opts.cwd,
        });
        scored.push({ filePath: entry.filePath, mtimeMs: entry.mtimeMs, sessionMeta, score });
    }
    scored.sort((a, b) => b.score - a.score);

    // Fresh discovery has no provider session id, so ownership must come from the rollout's own metadata.
    // Timestamp and mtime are ordering signals only: concurrent Codex roots and subagents can be equally fresh.
    const expectedCwd = resumeId ? null : await resolveCwdForComparison(opts.cwd);
    const candidates = [];
    for (const entry of scored) {
        if (
            resumeId
            || await isOwnedFreshRootRollout({
                sessionMeta: entry.sessionMeta,
                startedAtMs: opts.startedAtMs,
                expectedCwd,
            })
        ) {
            candidates.push(entry);
        }
    }

    const best = candidates[0];
    if (!best) return null;
    return { filePath: best.filePath, sessionMeta: best.sessionMeta };
}
