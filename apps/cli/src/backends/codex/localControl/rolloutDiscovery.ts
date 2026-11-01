import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
    normalizePathForComparison,
    resolvePathForComparison,
} from '@/utils/path/normalizePathForComparison';
import { parseCodexRolloutFilename } from '../utils/codexSessionFiles';

export type CodexSessionMetaPayload = {
    id?: string;
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

async function isOwnedFreshRootRollout(opts: {
    sessionMeta: CodexSessionMetaPayload;
    startedAtMs: number;
    expectedCwd: string | null;
}): Promise<boolean> {
    if (!isSessionMetaFreshForStart(opts)) return false;
    if (isSubagentRollout(opts.sessionMeta) || !opts.expectedCwd) return false;

    const candidateCwd = await resolvePathForComparison(opts.sessionMeta.cwd);
    return candidateCwd === opts.expectedCwd;
}

type RolloutFileEntry = Readonly<{ filePath: string; mtimeMs: number }>;

async function collectRolloutFiles(opts: ScanOptions): Promise<RolloutFileEntry[]> {
    const results: string[] = [];
    const maxDepth = Math.max(0, typeof opts.maxDepth === 'number' ? opts.maxDepth : 10);
    const scanLimit = Math.max(0, opts.scanLimit);

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth >= maxDepth || results.length >= scanLimit) return;

        let entries: any[];
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
    // long-lived Codex home can otherwise delay local-control attachment for minutes.
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

async function readFirstLine(filePath: string): Promise<string | null> {
    const chunkBytes = 4 * 1024;
    try {
        const fh = await open(filePath, 'r');
        try {
            const decoder = new StringDecoder('utf8');
            const chunk = Buffer.allocUnsafe(chunkBytes);
            let readOffset = 0;
            const parts: string[] = [];

            // session_meta includes full base instructions; its first record has no vendor size cap.
            // Stop at its newline so even a large transcript only needs its metadata head.
            while (true) {
                const res = await fh.read(chunk, 0, chunk.byteLength, readOffset);
                if (res.bytesRead <= 0) break;
                readOffset += res.bytesRead;
                const text = decoder.write(chunk.subarray(0, res.bytesRead));
                const idx = text.indexOf('\n');
                if (idx !== -1) {
                    parts.push(text.slice(0, idx));
                    const line = parts.join('').trim();
                    return line.length > 0 ? line : null;
                }
                parts.push(text);
                if (res.bytesRead < chunk.byteLength) break;
            }

            parts.push(decoder.end());
            const line = parts.join('').trim();
            return line.length > 0 ? line : null;
        } finally {
            await fh.close();
        }
    } catch {
        return null;
    }
}

export async function readCodexSessionMetaFromRollout(filePath: string): Promise<CodexSessionMetaPayload | null> {
    const line = await readFirstLine(filePath);
    if (!line) return null;
    try {
        const parsed = JSON.parse(line) as any;
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.type !== 'session_meta') return null;
        const payload = parsed.payload;
        if (!payload || typeof payload !== 'object') return null;
        return payload as CodexSessionMetaPayload;
    } catch {
        return null;
    }
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

    const expectedCwd = normalizePathForComparison(opts.cwd);
    const candidateCwd = normalizePathForComparison(opts.sessionMeta.cwd);
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
    const resumeId = typeof opts.resumeId === 'string' && opts.resumeId.trim().length > 0 ? opts.resumeId.trim() : null;

    // Fast-path: filename fragment match.
    if (resumeId) {
        const all = await collectRolloutFiles({ sessionsRootDir: opts.sessionsRootDir, scanLimit: opts.scanLimit });
        const matches = all.filter((p) => p.filePath.includes(resumeId));
        if (matches.length > 0) {
            // collectRolloutFiles returns newest-first by a stable creation-ish timestamp.
            for (const entry of matches) {
                const sessionMeta = await readCodexSessionMetaFromRollout(entry.filePath);
                if (sessionMeta) return { filePath: entry.filePath, sessionMeta };
                const idFromName = parseCodexRolloutFilename(entry.filePath)?.threadId ?? null;
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
            const idFromName = parseCodexRolloutFilename(entry.filePath)?.threadId ?? null;
            if (!idFromName) continue;
            if (entry.mtimeMs < opts.startedAtMs - CODEX_SESSION_META_CLOCK_SKEW_MS) continue;
            const fallbackMeta: CodexSessionMetaPayload = {
                id: idFromName,
                timestamp: new Date(entry.mtimeMs).toISOString(),
            };
            const score = scoreCodexRolloutCandidate({
                sessionMeta: fallbackMeta,
                startedAtMs: opts.startedAtMs,
                cwd: opts.cwd,
            });
            scored.push({ filePath: entry.filePath, mtimeMs: entry.mtimeMs, sessionMeta: fallbackMeta, score });
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

    // A fresh local-control launch has no provider session id yet, so ownership must be established by
    // the rollout's own metadata. Fail closed until session_meta proves that the rollout is fresh, belongs
    // to this workspace, and represents a root Codex session rather than a concurrent subagent.
    const expectedCwd = resumeId ? null : await resolvePathForComparison(opts.cwd);
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
