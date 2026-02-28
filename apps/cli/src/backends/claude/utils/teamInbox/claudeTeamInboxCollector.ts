import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { RawJSONLines } from '@/backends/claude/types';
import { logger } from '@/ui/logger';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';

type LeadInboxEntry = Readonly<{
  from?: unknown;
  text?: unknown;
  timestamp?: unknown;
  read?: unknown;
  color?: unknown;
  summary?: unknown;
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
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractToolUseResultFromToolResultItem(toolResultItem: unknown): Record<string, unknown> | null {
  if (!isRecord(toolResultItem)) return null;
  const direct = (toolResultItem as any).tool_use_result;
  if (isRecord(direct)) return direct;

  const content = (toolResultItem as any).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if ((block as any).type !== 'text') continue;
    const text = readFirstNonEmptyString((block as any).text);
    if (!text) continue;
    const parsed = tryParseJsonObject(text);
    const fromParsed = parsed ? (parsed as any).tool_use_result : null;
    if (isRecord(fromParsed)) return fromParsed;
  }
  return null;
}

function extractToolUsesFromAssistantMessage(message: RawJSONLines): ReadonlyArray<Readonly<{ id: string; name: string; input: unknown }>> {
  if (message.type !== 'assistant') return [];
  const content = (message as any)?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if ((block as any).type !== 'tool_use') continue;
    const id = readFirstNonEmptyString((block as any).id);
    const name = readFirstNonEmptyString((block as any).name);
    if (!id || !name) continue;
    out.push({ id, name, input: (block as any).input });
  }
  return out;
}

function extractToolResultsFromUserMessage(message: RawJSONLines): ReadonlyArray<Readonly<{ toolUseId: string; rawItem: unknown }>> {
  if (message.type !== 'user') return [];
  const content = (message as any)?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; rawItem: unknown }> = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if ((block as any).type !== 'tool_result') continue;
    const toolUseId = readFirstNonEmptyString((block as any).tool_use_id);
    if (!toolUseId) continue;
    out.push({ toolUseId, rawItem: block });
  }
  return out;
}

function readParsedToolUseResultFromMessage(message: RawJSONLines): Record<string, unknown> | null {
  if (message.type !== 'user') return null;
  const raw = (message as any).toolUseResult;
  return isRecord(raw) ? raw : null;
}

function resolveTeamNameFromToolUseInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const raw = (input as any).team_name ?? (input as any).teamName;
  return readFirstNonEmptyString(raw);
}

function resolveMemberNameFromToolUseInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  return readFirstNonEmptyString((input as any).name);
}

function sanitizeClaudeTeamName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 128) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('\0')) return null;
  // Prevent path traversal / absolute paths. Team names are used in file paths under ~/.claude/teams/<team>/...
  if (isAbsolute(trimmed)) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

export type ClaudeTeamInboxCollector = ReturnType<typeof createClaudeTeamInboxCollector>;

export function createClaudeTeamInboxCollector(params: Readonly<{
  claudeConfigDir: string | null;
  onInvalidate: () => void;
  emit: (message: RawJSONLines) => void;
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
  let leadInboxPath: string | null = null;
  let lastAssistantModel: string | null = null;

  const toolUseIdByMemberId = new Map<string, string>();
  const toolUseIdByMemberName = new Map<string, string>();
  const processedInboxKeys = new Set<string>();

  let watcher: { filePath: string; stop: () => void } | null = null;

  function ensureWatcher(): void {
    if (!leadInboxPath) return;
    if (watcher?.filePath === leadInboxPath) return;
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    try {
      watcher = {
        filePath: leadInboxPath,
        stop: startFileWatcher(leadInboxPath, () => params.onInvalidate()),
      };
    } catch {
      // Non-fatal: watcher may fail if file isn't present yet.
    }
  }

  function maybeUpdateTeamName(next: string | null): void {
    const sanitized = sanitizeClaudeTeamName(next);
    if (!sanitized || sanitized === teamName) return;
    teamName = sanitized;
    leadInboxPath = join(resolvedClaudeConfigDir, 'teams', teamName, 'inboxes', 'team-lead.json');
    ensureWatcher();
  }

  function observe(message: RawJSONLines): void {
    if (message.type === 'assistant') {
      const model = readFirstNonEmptyString((message as any)?.message?.model);
      if (model) lastAssistantModel = model;
    }

    for (const tool of extractToolUsesFromAssistantMessage(message)) {
      if (tool.name === 'AgentTeamCreate' || tool.name === 'TeamCreate') {
        const nextTeam = resolveTeamNameFromToolUseInput(tool.input);
        maybeUpdateTeamName(nextTeam);
      }

      // In agent-team sessions, teammate spawns can be inferred directly from the tool_use input:
      // the tool_use id is the sidechain anchor we want to attach inbox messages to.
      if (tool.name === 'Agent' || tool.name === 'Task') {
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
    if (parsedToolUseResult && (parsedToolUseResult as any).status === 'teammate_spawned') {
      const toolUseId = extractToolResultsFromUserMessage(message)[0]?.toolUseId ?? null;
      if (toolUseId) {
        const model = readFirstNonEmptyString((parsedToolUseResult as any).model);
        if (model) lastAssistantModel = model;

        const teamFromResult = readFirstNonEmptyString((parsedToolUseResult as any).team_name);
        if (teamFromResult) {
          maybeUpdateTeamName(teamFromResult);
        }

        const memberId =
          readFirstNonEmptyString((parsedToolUseResult as any).agent_id)
          ?? readFirstNonEmptyString((parsedToolUseResult as any).teammate_id);
        if (memberId) {
          toolUseIdByMemberId.set(memberId, toolUseId);
          const short = memberId.includes('@') ? memberId.split('@')[0] : memberId;
          if (short) toolUseIdByMemberName.set(short, toolUseId);
        }

        const memberName = readFirstNonEmptyString((parsedToolUseResult as any).name);
        if (memberName) {
          toolUseIdByMemberName.set(memberName, toolUseId);
        }
      }
    }

    for (const { toolUseId, rawItem } of extractToolResultsFromUserMessage(message)) {
      const toolUseResult = extractToolUseResultFromToolResultItem(rawItem);
      if (!toolUseResult) continue;
      if ((toolUseResult as any).status !== 'teammate_spawned') continue;

      const model = readFirstNonEmptyString((toolUseResult as any).model);
      if (model) lastAssistantModel = model;

      const teamFromResult = readFirstNonEmptyString((toolUseResult as any).team_name);
      if (teamFromResult) {
        maybeUpdateTeamName(teamFromResult);
      }

      const memberId =
        readFirstNonEmptyString((toolUseResult as any).agent_id)
        ?? readFirstNonEmptyString((toolUseResult as any).teammate_id);
      if (memberId) {
        toolUseIdByMemberId.set(memberId, toolUseId);
        const short = memberId.includes('@') ? memberId.split('@')[0] : memberId;
        if (short) toolUseIdByMemberName.set(short, toolUseId);
      }

      const memberName = readFirstNonEmptyString((toolUseResult as any).name);
      if (memberName) {
        toolUseIdByMemberName.set(memberName, toolUseId);
      }
    }
  }

  async function syncAll(): Promise<void> {
    if (!leadInboxPath || !teamName) return;

    let raw: string;
    try {
      raw = await readFile(leadInboxPath, 'utf-8');
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
    const nextEntries: any[] = [];

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
        } as any);
      }

      nextEntries.push({ ...entryRaw, read: true });
      didMutate = true;
    }

    if (!didMutate) return;
    try {
      await writeFile(leadInboxPath, JSON.stringify(nextEntries, null, 2), 'utf-8');
    } catch (error) {
      logger.debug('[claude-team-inbox] Failed to mark inbox entries as read (non-fatal)', { error });
    }
  }

  function cleanup(): void {
    if (watcher) watcher.stop();
    watcher = null;
  }

  return { observe, syncAll, cleanup };
}
