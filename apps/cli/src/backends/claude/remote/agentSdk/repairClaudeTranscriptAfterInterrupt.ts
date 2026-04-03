import { appendFile, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { getProjectPath } from '@/backends/claude/utils/path';
import { configuration } from '@/configuration';

type TranscriptEntry = Readonly<{
    type?: string;
    uuid?: string;
    session_id?: string;
    parent_tool_use_id?: string | null;
    message?: Readonly<{
        role?: string;
        content?: unknown;
    }>;
}>;

function parseJsonLine(line: string): TranscriptEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as TranscriptEntry;
    } catch {
        return null;
    }
}

function extractToolUseIds(entry: TranscriptEntry): string[] {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return [];
    const out: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type !== 'tool_use') continue;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (id) out.push(id);
    }
    return out;
}

function extractToolResultIds(entry: TranscriptEntry): string[] {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return [];
    const out: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type !== 'tool_result') continue;
        const id = typeof record.tool_use_id === 'string' ? record.tool_use_id.trim() : '';
        if (id) out.push(id);
    }
    return out;
}

function resolveTranscriptPath(params: Readonly<{
    sessionId: string | null;
    transcriptPath: string | null;
    workDir: string;
    claudeConfigDir: string | null;
}>): string {
    const projectPath = getProjectPath(params.workDir, params.claudeConfigDir);
    const projectRoot = resolve(projectPath);

    const isWithinProjectDir = (candidatePath: string): boolean => {
        const resolved = resolve(candidatePath);
        const rel = relative(projectRoot, resolved);
        if (!rel) return true;
        if (isAbsolute(rel)) return false;
        return !rel.startsWith('..');
    };

    const explicit = String(params.transcriptPath ?? '').trim();
    if (explicit) {
        const resolved = resolve(explicit);
        if (!isWithinProjectDir(resolved)) return '';
        return resolved;
    }

    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) return '';
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId) || sessionId.length > 200) return '';

    const derived = join(projectPath, `${sessionId}.jsonl`);
    if (!isWithinProjectDir(derived)) return '';
    return resolve(derived);
}

async function waitForTranscriptToSettle(params: Readonly<{ transcriptPath: string }>): Promise<boolean> {
    const timeoutMs = configuration.claudeTranscriptRepairWaitForToolUseIdsTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return true;

    const pollIntervalMs = configuration.claudeTranscriptRepairWaitForToolUseIdsPollIntervalMs;
    const effectivePollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 10 ? pollIntervalMs : 25;

    const deadline = Date.now() + timeoutMs;
    const handle = await open(params.transcriptPath, 'r');
    try {
        let stat = await handle.stat();
        let lastSize = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
        let lastMtimeMs = Number.isFinite((stat as any).mtimeMs)
            ? Math.trunc((stat as any).mtimeMs as number)
            : Math.trunc(stat.mtime.getTime());

        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, effectivePollIntervalMs));
            stat = await handle.stat();
            const size = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
            const mtimeMs = Number.isFinite((stat as any).mtimeMs)
                ? Math.trunc((stat as any).mtimeMs as number)
                : Math.trunc(stat.mtime.getTime());

            if (size === lastSize && mtimeMs === lastMtimeMs) {
                return true;
            }

            lastSize = size;
            lastMtimeMs = mtimeMs;
        }

        return false;
    } finally {
        await handle.close();
    }
}

async function waitForToolResultIdsToAppear(params: Readonly<{ transcriptPath: string; toolUseIds: readonly string[] }>): Promise<void> {
    const timeoutMs = configuration.claudeTranscriptRepairWaitForToolUseIdsTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;

    const pollIntervalMs = configuration.claudeTranscriptRepairWaitForToolUseIdsPollIntervalMs;
    const effectivePollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 10 ? pollIntervalMs : 25;

    const expected = params.toolUseIds
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id.length > 0);
    if (expected.length === 0) return;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const { text, truncatedPrefix } = await readTailUtf8(params.transcriptPath, configuration.filesReadMaxBytes);
            const rawLines = text.split(/\r?\n/u);
            const lines = truncatedPrefix ? rawLines.slice(1) : rawLines;

            const seenResults = new Set<string>();
            for (const line of lines) {
                const entry = parseJsonLine(line ?? '');
                if (!entry) continue;
                for (const id of extractToolResultIds(entry)) {
                    seenResults.add(id);
                }
            }

            let missing = 0;
            for (const toolUseId of expected) {
                if (!seenResults.has(toolUseId)) missing += 1;
            }
            if (missing === 0) return;
        } catch {
            // Best-effort only: if the file is missing or mid-write, keep waiting.
        }

        await new Promise((resolve) => setTimeout(resolve, effectivePollIntervalMs));
    }
}

async function readTailUtf8(path: string, maxBytes: number): Promise<{ text: string; truncatedPrefix: boolean }> {
    const handle = await open(path, 'r');
    try {
        const stat = await handle.stat();
        const size = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
        const boundedMaxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 1;
        const start = Math.max(0, size - boundedMaxBytes);
        const length = size - start;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, start);
        return { text: buf.toString('utf8'), truncatedPrefix: start > 0 };
    } finally {
        await handle.close();
    }
}

async function repairJsonlTail(params: Readonly<{ transcriptPath: string }>): Promise<void> {
    const maxBytes = configuration.filesReadMaxBytes;
    const effectiveMaxBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 1;

    const settleTimeoutMs = configuration.claudeTranscriptRepairWaitForToolUseIdsTimeoutMs;
    const settleEnabled = Number.isFinite(settleTimeoutMs) && settleTimeoutMs > 0;
    const pollIntervalMs = configuration.claudeTranscriptRepairWaitForToolUseIdsPollIntervalMs;
    const effectivePollIntervalMs = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 10 ? pollIntervalMs : 25;

    const handle = await open(params.transcriptPath, 'r+');
    try {
        const deadline = settleEnabled ? Date.now() + settleTimeoutMs : 0;

        while (true) {
            const stat = await handle.stat();
            const size = Number.isFinite(stat.size) ? Math.max(0, Math.trunc(stat.size)) : 0;
            if (size === 0) return;

            const readSize = Math.min(size, effectiveMaxBytes);
            const start = Math.max(0, size - readSize);
            const length = size - start;
            const buf = Buffer.alloc(length);
            await handle.read(buf, 0, length, start);

            if (buf.length > 0 && buf[buf.length - 1] === 0x0a) {
                return;
            }

            const lastNewlineIndex = buf.lastIndexOf(0x0a);
            if (lastNewlineIndex === -1) return;

            const tailLine = buf.slice(lastNewlineIndex + 1).toString('utf8').trim();
            if (tailLine.length === 0) {
                await appendFile(params.transcriptPath, '\n');
                return;
            }

            try {
                JSON.parse(tailLine);
                await appendFile(params.transcriptPath, '\n');
                return;
            } catch {
                // Fall through: invalid last line. Prefer waiting briefly for an in-flight write to settle
                // rather than truncating immediately and potentially losing data.
            }

            if (settleEnabled && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, effectivePollIntervalMs));
                continue;
            }

            const truncateTo = start + lastNewlineIndex + 1;
            if (truncateTo >= 0 && truncateTo < size) {
                await handle.truncate(truncateTo);
            }
            return;
        }
    } catch {
        // Best-effort: transcript tail repair should never crash callers.
    } finally {
        await handle.close();
    }
}

export async function repairClaudeTranscriptAfterInterrupt(params: Readonly<{
    sessionId: string | null;
    transcriptPath: string | null;
    workDir: string;
    claudeConfigDir: string | null;
}>): Promise<void> {
    const path = resolveTranscriptPath(params);
    if (!path) return;

    const settled = await waitForTranscriptToSettle({ transcriptPath: path }).catch(() => false);
    if (!settled) return;

    await repairJsonlTail({ transcriptPath: path });

    const computeMissingToolResults = async (): Promise<{ missing: string[]; text: string }> => {
        const { text, truncatedPrefix } = await readTailUtf8(path, configuration.filesReadMaxBytes).catch(() => ({
            text: '',
            truncatedPrefix: false,
        }));
        if (!text.trim()) return { missing: [], text };

        const rawLines = text.split(/\r?\n/u);
        const lines = truncatedPrefix ? rawLines.slice(1) : rawLines;

        let lastToolUseIndex = -1;
        let lastToolUseIds: string[] = [];
        for (let i = 0; i < lines.length; i += 1) {
            const entry = parseJsonLine(lines[i] ?? '');
            if (!entry) continue;
            const ids = extractToolUseIds(entry);
            if (ids.length > 0) {
                lastToolUseIndex = i;
                lastToolUseIds = ids;
            }
        }
        if (lastToolUseIndex < 0 || lastToolUseIds.length === 0) return { missing: [], text };

        const seenResults = new Set<string>();
        for (let i = lastToolUseIndex + 1; i < lines.length; i += 1) {
            const entry = parseJsonLine(lines[i] ?? '');
            if (!entry) continue;
            for (const id of extractToolResultIds(entry)) {
                seenResults.add(id);
            }
        }

        const missing = lastToolUseIds.filter((id) => !seenResults.has(id));
        return { missing, text };
    };

    const initialMissing = await computeMissingToolResults();
    if (initialMissing.missing.length === 0) return;

    await waitForToolResultIdsToAppear({ transcriptPath: path, toolUseIds: initialMissing.missing });

    const afterWait = await computeMissingToolResults();
    const missing = afterWait.missing;
    const text = afterWait.text;
    if (missing.length === 0) return;

    const prefix = text.endsWith('\n') ? '' : '\n';
    const appended = missing.map((toolUseId) =>
        JSON.stringify({
            type: 'user',
            uuid: toolUseId,
            isSidechain: false,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: 'Interrupted',
                        is_error: true,
                    },
                ],
            },
        }),
    ).join('\n');

    await appendFile(path, `${prefix}${appended}\n`, 'utf8');
}
