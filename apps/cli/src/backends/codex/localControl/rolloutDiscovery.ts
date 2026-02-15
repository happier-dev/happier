import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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

async function collectRolloutFiles(opts: ScanOptions): Promise<string[]> {
    const results: string[] = [];
    const maxDepth = Math.max(0, typeof opts.maxDepth === 'number' ? opts.maxDepth : 10);

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth >= maxDepth) return;

        let entries: any[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
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

    // Prefer newest by filename timestamp (or filesystem birthtime), not by mtime. Active sessions will keep mtime fresh.
    const withTime: Array<{ filePath: string; sortMs: number; mtimeMs: number }> = [];
    for (const filePath of results) {
        try {
            const s = await stat(filePath);
            const fromName = parseRolloutTimestampFromFilename(filePath);
            const fromBirth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 ? s.birthtimeMs : null;
            const sortMs = fromName ?? fromBirth ?? s.mtimeMs;
            withTime.push({ filePath, sortMs, mtimeMs: s.mtimeMs });
        } catch {
            // ignore unreadable files
        }
    }
    withTime.sort((a, b) => b.sortMs - a.sortMs || b.mtimeMs - a.mtimeMs);
    return withTime.slice(0, Math.max(0, opts.scanLimit)).map((x) => x.filePath);
}

async function readFirstLine(filePath: string): Promise<string | null> {
    const maxProbeBytes = 64 * 1024;
    const chunkBytes = 4 * 1024;
    try {
        const fh = await open(filePath, 'r');
        try {
            const decoder = new StringDecoder('utf8');
            const chunk = Buffer.allocUnsafe(chunkBytes);
            let readOffset = 0;
            let text = '';
            let sawEof = false;

            while (readOffset < maxProbeBytes) {
                const bytesToRead = Math.min(chunk.byteLength, maxProbeBytes - readOffset);
                const res = await fh.read(chunk, 0, bytesToRead, readOffset);
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

    // Weak signal only.
    if (typeof opts.sessionMeta.cwd === 'string') {
        if (opts.sessionMeta.cwd === opts.cwd) score += 20;
        else if (opts.cwd.startsWith(opts.sessionMeta.cwd)) score += 5;
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
        const matches = all.filter((p) => p.includes(resumeId));
        if (matches.length > 0) {
            // collectRolloutFiles returns newest-first by a stable creation-ish timestamp.
            for (const filePath of matches) {
                const sessionMeta = await readCodexSessionMetaFromRollout(filePath);
                if (!sessionMeta) continue;
                return { filePath, sessionMeta };
            }
        }
    }

    const files = await collectRolloutFiles({ sessionsRootDir: opts.sessionsRootDir, scanLimit: opts.scanLimit });
    const scored: Array<{ filePath: string; sessionMeta: CodexSessionMetaPayload; score: number }> = [];
    for (const filePath of files) {
        const sessionMeta = await readCodexSessionMetaFromRollout(filePath);
        if (!sessionMeta) continue;
        const score = scoreCodexRolloutCandidate({
            sessionMeta,
            startedAtMs: opts.startedAtMs,
            cwd: opts.cwd,
        });
        scored.push({ filePath, sessionMeta, score });
    }
    scored.sort((a, b) => b.score - a.score);

    // When starting a brand-new Codex session, ignore stale rollout files and keep polling until a fresh one appears.
    const candidates = resumeId
        ? scored
        : scored.filter((entry) => isSessionMetaFreshForStart({ sessionMeta: entry.sessionMeta, startedAtMs: opts.startedAtMs }));

    const best = candidates[0];
    if (!best) return null;
    return { filePath: best.filePath, sessionMeta: best.sessionMeta };
}
