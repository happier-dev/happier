import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import type { RawJSONLines } from '../../transcripts/rawJsonLines.js';

type LeadInboxEntry = Readonly<{
    from?: unknown;
    text?: unknown;
    timestamp?: unknown;
    read?: unknown;
}>;

type ToolUse = Readonly<{
    id: string;
    name: string;
    input: unknown;
}>;

type ToolResult = Readonly<{
    toolUseId: string;
    rawItem: unknown;
}>;

type Watcher = Readonly<{
    filePath: string;
    stop: () => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFirstNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function readMessageRecord(message: RawJSONLines): Record<string, unknown> | null {
    return isRecord(message.message) ? message.message : null;
}

function readMessageContent(message: RawJSONLines): readonly unknown[] {
    const messageRecord = readMessageRecord(message);
    return Array.isArray(messageRecord?.content) ? messageRecord.content : [];
}

function extractToolUseResultFromToolResultItem(toolResultItem: unknown): Record<string, unknown> | null {
    if (!isRecord(toolResultItem)) return null;
    const direct = toolResultItem.tool_use_result;
    if (isRecord(direct)) return direct;

    const content = toolResultItem.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type !== 'text') continue;
        const text = readFirstNonEmptyString(block.text);
        if (!text) continue;
        const parsed = tryParseJsonObject(text);
        const fromParsed = parsed?.tool_use_result;
        if (isRecord(fromParsed)) return fromParsed;
    }
    return null;
}

function extractToolUsesFromAssistantMessage(message: RawJSONLines): readonly ToolUse[] {
    if (message.type !== 'assistant') return [];
    const out: ToolUse[] = [];
    for (const block of readMessageContent(message)) {
        if (!isRecord(block)) continue;
        if (block.type !== 'tool_use') continue;
        const id = readFirstNonEmptyString(block.id);
        const name = readFirstNonEmptyString(block.name);
        if (!id || !name) continue;
        out.push({ id, name, input: block.input });
    }
    return out;
}

function extractToolResultsFromUserMessage(message: RawJSONLines): readonly ToolResult[] {
    if (message.type !== 'user') return [];
    const out: ToolResult[] = [];
    for (const block of readMessageContent(message)) {
        if (!isRecord(block)) continue;
        if (block.type !== 'tool_result') continue;
        const toolUseId = readFirstNonEmptyString(block.tool_use_id);
        if (!toolUseId) continue;
        out.push({ toolUseId, rawItem: block });
    }
    return out;
}

function readParsedToolUseResultFromMessage(message: RawJSONLines): Record<string, unknown> | null {
    if (message.type !== 'user') return null;
    const raw = message.toolUseResult;
    return isRecord(raw) ? raw : null;
}

function resolveTeamNameFromToolUseInput(input: unknown): string | null {
    if (!isRecord(input)) return null;
    return readFirstNonEmptyString(input.team_name) ?? readFirstNonEmptyString(input.teamName);
}

function resolveMemberNameFromToolUseInput(input: unknown): string | null {
    if (!isRecord(input)) return null;
    return readFirstNonEmptyString(input.name);
}

export function sanitizeClaudeTeamName(value: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 128) return null;
    if (trimmed === '.' || trimmed === '..') return null;
    if (trimmed.includes('\0')) return null;
    if (isAbsolute(trimmed)) return null;
    if (trimmed.includes('/') || trimmed.includes('\\')) return null;
    return trimmed;
}

export type ClaudeTeamInboxCollector = ReturnType<typeof createClaudeTeamInboxCollector>;

export function createClaudeTeamInboxCollector(params: Readonly<{
    claudeConfigDir: string | null;
    onInvalidate: () => void;
    emit: (message: RawJSONLines) => void;
    watchFile?: (filePath: string, onChange: () => void) => () => void;
    logDebug?: (message: string, metadata?: unknown) => void;
}>): {
    observe: (message: RawJSONLines) => void;
    syncAll: () => Promise<void>;
    cleanup: () => void;
} {
    const resolvedClaudeConfigDir = (() => {
        const raw = (params.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? '').trim();
        return raw.length > 0 ? raw : join(homedir(), '.claude');
    })();

    let teamName: string | null = null;
    let leadInboxFile: string | null = null;
    let lastAssistantModel: string | null = null;

    const toolUseIdByMemberId = new Map<string, string>();
    const toolUseIdByMemberName = new Map<string, string>();
    const processedInboxKeys = new Set<string>();

    let watcher: Watcher | null = null;

    function ensureWatcher(): void {
        if (!leadInboxFile || !params.watchFile) return;
        if (watcher?.filePath === leadInboxFile) return;
        if (watcher) {
            watcher.stop();
            watcher = null;
        }
        try {
            watcher = {
                filePath: leadInboxFile,
                stop: params.watchFile(leadInboxFile, params.onInvalidate),
            };
        } catch {
            // Watcher setup is best-effort; the polling sync path still observes the inbox.
        }
    }

    function maybeUpdateTeamName(next: string | null): void {
        const sanitized = sanitizeClaudeTeamName(next);
        if (!sanitized || sanitized === teamName) return;
        teamName = sanitized;
        leadInboxFile = join(resolvedClaudeConfigDir, 'teams', teamName, 'inboxes', 'team-lead.json');
        ensureWatcher();
    }

    function rememberSpawnedTeammate(paramsInner: Readonly<{
        toolUseId: string;
        toolUseResult: Record<string, unknown>;
    }>): void {
        const model = readFirstNonEmptyString(paramsInner.toolUseResult.model);
        if (model) lastAssistantModel = model;

        const teamFromResult = readFirstNonEmptyString(paramsInner.toolUseResult.team_name);
        if (teamFromResult) {
            maybeUpdateTeamName(teamFromResult);
        }

        const memberId =
            readFirstNonEmptyString(paramsInner.toolUseResult.agent_id)
            ?? readFirstNonEmptyString(paramsInner.toolUseResult.teammate_id);
        if (memberId) {
            toolUseIdByMemberId.set(memberId, paramsInner.toolUseId);
            const short = memberId.includes('@') ? memberId.split('@')[0] : memberId;
            if (short) toolUseIdByMemberName.set(short, paramsInner.toolUseId);
        }

        const memberName = readFirstNonEmptyString(paramsInner.toolUseResult.name);
        if (memberName) {
            toolUseIdByMemberName.set(memberName, paramsInner.toolUseId);
        }
    }

    function observe(message: RawJSONLines): void {
        if (message.type === 'assistant') {
            const model = readFirstNonEmptyString(readMessageRecord(message)?.model);
            if (model) lastAssistantModel = model;
        }

        for (const tool of extractToolUsesFromAssistantMessage(message)) {
            if (tool.name === 'AgentTeamCreate' || tool.name === 'TeamCreate') {
                maybeUpdateTeamName(resolveTeamNameFromToolUseInput(tool.input));
            }

            if (isGenericSubAgentToolName(tool.name)) {
                const teamFromInput = resolveTeamNameFromToolUseInput(tool.input);
                const memberName = resolveMemberNameFromToolUseInput(tool.input);
                if (teamFromInput) {
                    maybeUpdateTeamName(teamFromInput);
                }
                if (teamFromInput && memberName) {
                    const memberId = memberName.includes('@') ? memberName : `${memberName}@${teamFromInput}`;
                    toolUseIdByMemberName.set(memberName, tool.id);
                    toolUseIdByMemberId.set(memberId, tool.id);
                    const short = memberName.includes('@') ? memberName.split('@')[0] : memberName;
                    if (short) toolUseIdByMemberName.set(short, tool.id);
                }
            }
        }

        const parsedToolUseResult = readParsedToolUseResultFromMessage(message);
        if (parsedToolUseResult && parsedToolUseResult.status === 'teammate_spawned') {
            const toolUseId = extractToolResultsFromUserMessage(message)[0]?.toolUseId ?? null;
            if (toolUseId) {
                rememberSpawnedTeammate({ toolUseId, toolUseResult: parsedToolUseResult });
            }
        }

        for (const { toolUseId, rawItem } of extractToolResultsFromUserMessage(message)) {
            const toolUseResult = extractToolUseResultFromToolResultItem(rawItem);
            if (!toolUseResult) continue;
            if (toolUseResult.status !== 'teammate_spawned') continue;
            rememberSpawnedTeammate({ toolUseId, toolUseResult });
        }
    }

    async function syncAll(): Promise<void> {
        if (!leadInboxFile || !teamName) return;

        let raw: string;
        try {
            raw = await readFile(leadInboxFile, 'utf-8');
        } catch {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) return;

        let didMutate = false;
        const nextEntries: unknown[] = [];

        for (const entryRaw of parsed) {
            if (!isRecord(entryRaw)) {
                nextEntries.push(entryRaw);
                continue;
            }
            const entry = entryRaw as LeadInboxEntry;
            const from = readFirstNonEmptyString(entry.from);
            const text = readFirstNonEmptyString(entry.text);
            const timestamp = readFirstNonEmptyString(entry.timestamp) ?? '';
            const alreadyRead = entry.read === true;

            if (!from || !text || alreadyRead) {
                nextEntries.push(entryRaw);
                continue;
            }

            const toolUseId =
                toolUseIdByMemberName.get(from)
                ?? toolUseIdByMemberId.get(from.includes('@') ? from : `${from}@${teamName}`)
                ?? null;
            if (!toolUseId) {
                nextEntries.push(entryRaw);
                continue;
            }

            const key = `${from}:${timestamp}:${text}`;
            if (!processedInboxKeys.has(key)) {
                processedInboxKeys.add(key);
                params.emit({
                    type: 'assistant',
                    uuid: `team_inbox_${randomUUID()}`,
                    isSidechain: true,
                    sidechainId: toolUseId,
                    message: {
                        role: 'assistant',
                        model: lastAssistantModel ?? 'unknown',
                        content: [{ type: 'text', text }],
                    },
                });
            }

            nextEntries.push({ ...entryRaw, read: true });
            didMutate = true;
        }

        if (!didMutate) return;
        try {
            await writeFile(leadInboxFile, JSON.stringify(nextEntries, null, 2), 'utf-8');
        } catch (error) {
            params.logDebug?.('[claude-team-inbox] Failed to mark inbox entries as read (non-fatal)', { error });
        }
    }

    function cleanup(): void {
        if (watcher) watcher.stop();
        watcher = null;
    }

    return { observe, syncAll, cleanup };
}
