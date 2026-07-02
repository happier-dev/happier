import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFirstLineUtf8(filePath: string): string | null {
    let fd: number | null = null;
    try {
        fd = openSync(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        if (bytes <= 0) return null;
        const text = buf.toString('utf8', 0, bytes);
        const idx = text.indexOf('\n');
        const firstLine = (idx >= 0 ? text.slice(0, idx) : text).trim();
        return firstLine.length > 0 ? firstLine : null;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // ignore close failures from best-effort path probing
            }
        }
    }
}

function coerceStringContentFromJsonlRecord(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const message = value.message;
    if (!isRecord(message)) return null;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!isRecord(item)) continue;
        if (item.type !== 'text') continue;
        const text = item.text;
        if (typeof text === 'string' && text.trim().length > 0) parts.push(text);
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readDirectoryEntries(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function resolveJsonlPathFromToolUseMetadata(subagentsDir: string, sidechainId: string): string | null {
    for (const fileName of readDirectoryEntries(subagentsDir)) {
        if (!fileName.startsWith('agent-') || !fileName.endsWith('.meta.json')) continue;
        const metaPath = join(subagentsDir, fileName);
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
        } catch {
            continue;
        }
        if (!isRecord(parsed)) continue;
        const toolUseId = parsed.toolUseId;
        if (typeof toolUseId !== 'string' || toolUseId.trim() !== sidechainId) continue;

        const jsonlPath = join(subagentsDir, fileName.replace(/\.meta\.json$/, '.jsonl'));
        return existsSync(jsonlPath) ? jsonlPath : null;
    }
    return null;
}

export function resolveClaudeSubagentJsonlPath(params: Readonly<{
    projectDir: string;
    claudeSessionId: string;
    agentId?: string;
    sidechainId?: string;
}>): string | null {
    const sanitizedSessionId = String(params.claudeSessionId ?? '').trim();
    if (!sanitizedSessionId) return null;
    const sanitizedAgentId = String(params.agentId ?? '').trim();

    const subagentsDir = join(params.projectDir, sanitizedSessionId, 'subagents');
    const sidechainId = typeof params.sidechainId === 'string' ? params.sidechainId.trim() : '';
    if (sidechainId) {
        const fromMeta = resolveJsonlPathFromToolUseMetadata(subagentsDir, sidechainId);
        if (fromMeta) return fromMeta;
    }

    if (!sanitizedAgentId) return null;

    const direct = join(subagentsDir, `agent-${sanitizedAgentId}.jsonl`);
    if (existsSync(direct)) return direct;

    const atIndex = sanitizedAgentId.indexOf('@');
    if (atIndex <= 0) return null;
    const nameGuess = sanitizedAgentId.slice(0, atIndex).trim();
    if (!nameGuess) return null;

    const youAreRe = new RegExp(`\\bYou\\s+are\\s+${escapeRegExp(nameGuess)}\\b`, 'i');
    const summaryRe = new RegExp(`summary\\s*=\\s*"\\s*${escapeRegExp(nameGuess)}`, 'i');
    const summaryContainsNameRe = new RegExp(
        `summary\\s*=\\s*["'][^"']*\\b${escapeRegExp(nameGuess)}\\b[^"']*["']`,
        'i',
    );

    for (const fileName of readDirectoryEntries(subagentsDir)) {
        if (!fileName.startsWith('agent-') || !fileName.endsWith('.jsonl')) continue;
        const candidate = join(subagentsDir, fileName);
        const firstLine = readFirstLineUtf8(candidate);
        if (!firstLine) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(firstLine);
        } catch {
            continue;
        }
        const content = coerceStringContentFromJsonlRecord(parsed);
        if (!content) continue;
        if (youAreRe.test(content) || summaryRe.test(content) || summaryContainsNameRe.test(content)) {
            return candidate;
        }
    }

    return null;
}
