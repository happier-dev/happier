import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { RawJSONLines } from '@happier-dev/plugins-claude/agent';
import { configuration } from '@/configuration';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import {
  coerceClaudeToolResultText,
  extractAgentIdFromTaskResultText,
  extractOutputFilePathFromTaskResultText,
  isClaudePromptRootSidechainUserMessage,
  markClaudeRecordAsSidechain,
  parseRawJsonLinesObject,
} from '@happier-dev/plugins-claude/agent';

import {
  markUuidSeenAndReturnIsDuplicate,
  LruSet,
} from './_shared';

import { realpath } from 'node:fs/promises';
import { createJsonlFollowController } from '@/api/session/fileBackedTranscripts/jsonl/createJsonlFollowController';
import type { JsonlFollowController } from '@/api/session/fileBackedTranscripts/jsonl/createJsonlFollowController';
import { normalizeJsonlFollowPolicy } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';
import type { JsonlFollowPolicyInputV1, JsonlFollowPolicyV1 } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

type WatchFile = (file: string, onFileChange: (file: string) => void) => () => void;

type EmitImported = (body: RawJSONLines, meta: Record<string, unknown>) => void;

type ResolveJsonlPathForAgentId = (params: {
  agentId?: string | null;
  sidechainId: string;
  claudeSessionId: string | null;
}) => string | null;

type Entry = {
  sidechainId: string; // Task tool_use id
  agentId: string | null;
  outputFilePath: string;
  resolvedJsonlPath: string;
  controller: JsonlFollowController;
  closeTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
};

export class ClaudeRemoteSubagentFileCollector {
  private readonly emitImported: EmitImported;
  private readonly watchFile: WatchFile;
  private readonly resolveJsonlPathForAgentId: ResolveJsonlPathForAgentId | null;

  private lastClaudeSessionId: string | null = null;
  private toolNameByToolUseId = new Map<string, string>();
  private agentIdByToolUseId = new Map<string, string>();
  private pendingRegistrations = new Set<Promise<void>>();
  private readonly pendingBySidechainId = new Map<string, { sidechainId: string; agentId: string | null; closeAfterRegister: boolean }>();
  private readonly entriesBySidechainId = new Map<string, Entry>();
  private readonly registeringSidechainIds = new Set<string>();
  private readonly sidechainIdByJsonlPath = new Map<string, string>();
  private readonly seenUuidsBySidechainId = new Map<string, LruSet>();
  private readonly closedSidechainRecords = new Map<string, { resolvedJsonlPath: string; closedAtMs: number }>();
  private readonly followPolicy: JsonlFollowPolicyV1;
  private lifecycleGeneration = 0;
  private disposed = false;

  constructor(opts: {
    emitImported: EmitImported;
    watchFile?: WatchFile;
    resolveJsonlPathForAgentId?: ResolveJsonlPathForAgentId;
    followPolicy?: JsonlFollowPolicyInputV1;
  }) {
    this.emitImported = opts.emitImported;
    this.watchFile = opts.watchFile ?? startFileWatcher;
    this.resolveJsonlPathForAgentId = opts.resolveJsonlPathForAgentId ?? null;
    this.followPolicy = normalizeJsonlFollowPolicy({
      activeBurstPollIntervalMs: configuration.claudeSubagentJsonlPollIntervalMs,
      ...opts.followPolicy,
    });
  }

  observe(message: SDKMessage): void {
    if (this.disposed) return;
    this.observeClaudeSessionId(message);
    if ((message as any)?.type === 'assistant') {
      this.observeAssistantToolUses(message as SDKAssistantMessage);
      return;
    }
    if ((message as any)?.type === 'user') {
      this.observeUserToolResults(message as SDKUserMessage);
    }
  }

  cleanup(): void {
    this.disposed = true;
    this.lifecycleGeneration += 1;
    for (const entry of this.entriesBySidechainId.values()) {
      if (entry.closeTimer) {
        clearTimeout(entry.closeTimer);
        entry.closeTimer = null;
      }
      void entry.controller.dispose();
    }
    this.entriesBySidechainId.clear();
    this.sidechainIdByJsonlPath.clear();
    this.toolNameByToolUseId.clear();
    this.agentIdByToolUseId.clear();
    this.pendingBySidechainId.clear();
    this.pendingRegistrations.clear();
    this.registeringSidechainIds.clear();
    this.closedSidechainRecords.clear();
    this.seenUuidsBySidechainId.clear();
  }

  async syncAll(): Promise<void> {
    if (this.disposed) return;
    if (this.pendingRegistrations.size > 0) {
      // Ensure we don't miss an initial import in the same tick as Task tool_result observation.
      await Promise.allSettled([...this.pendingRegistrations]);
    }
    this.flushPendingRegistrations();
    if (this.pendingRegistrations.size > 0) {
      await Promise.allSettled([...this.pendingRegistrations]);
    }
    for (const entry of this.entriesBySidechainId.values()) {
      await entry.controller.drainNow();
    }
  }

  private observeAssistantToolUses(message: SDKAssistantMessage): void {
    const content = (message as any)?.message?.content;
    if (!Array.isArray(content)) return;

    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as any).type !== 'tool_use') continue;

      const toolUseId = String((item as any).id ?? '').trim();
      const toolName = String((item as any).name ?? '').trim();
      if (!toolUseId || !toolName) continue;
      this.toolNameByToolUseId.set(toolUseId, toolName);
      const genericSubagentTool = isGenericSubAgentToolName(toolName);
      let agentIdFromInput = '';
      if (toolName === 'Agent') {
        const resolvedAgentIdFromInput = this.extractAgentIdFromAgentToolUseInput((item as any).input);
        if (resolvedAgentIdFromInput) {
          this.agentIdByToolUseId.set(toolUseId, resolvedAgentIdFromInput);
          agentIdFromInput = resolvedAgentIdFromInput;
        }
      }
      if (genericSubagentTool && this.resolveJsonlPathForAgentId && !this.entriesBySidechainId.has(toolUseId)) {
        this.rememberPendingSidechain({
          sidechainId: toolUseId,
          agentId: agentIdFromInput || null,
          closeAfterRegister: false,
        });
        this.flushPendingRegistrations();
      }
    }
  }

  private observeUserToolResults(message: SDKUserMessage): void {
    const content = (message as any)?.message?.content;
    if (!Array.isArray(content)) return;

    const toolUseResult = (message as any)?.tool_use_result ?? (message as any)?.toolUseResult;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as any).type !== 'tool_result') continue;

      const toolUseId = String((item as any).tool_use_id ?? '').trim();
      if (!toolUseId) continue;

      const toolName = this.toolNameByToolUseId.get(toolUseId) ?? null;
      // Execution runs and Claude agent teams both surface sub-agent transcripts as JSONL files.
      // - `Task` tool results often include `output_file`
      // - `Agent` (agent-teams) tool results typically do not, so we resolve by agent_id + session_id
      if (!toolName || !isGenericSubAgentToolName(toolName)) continue;

      const toolResultText = coerceClaudeToolResultText(
        toolUseResult !== undefined ? { content: (item as any).content, tool_use_result: toolUseResult } : (item as any).content,
      );
      const closeAfterRegister = shouldCloseSidechainAfterParentToolResult({
        toolName,
        toolUseResult,
      });
      const ids = extractAgentIdFromTaskResultText(toolResultText);
      const agentIdFromToolUseResult =
        typeof toolUseResult?.agent_id === 'string'
          ? String(toolUseResult.agent_id).trim()
          : typeof toolUseResult?.agentId === 'string'
            ? String(toolUseResult.agentId).trim()
            : typeof toolUseResult?.teammate_id === 'string'
              ? String(toolUseResult.teammate_id).trim()
              : '';
      const agentIdFromToolUseInput = this.agentIdByToolUseId.get(toolUseId) ?? '';
      const agentId = agentIdFromToolUseResult || (ids.agentId ? String(ids.agentId).trim() : '') || agentIdFromToolUseInput;
      if (!agentId) continue;

      const outputFilePath =
        extractOutputFilePathFromTaskResultText(toolResultText) ??
        (typeof toolUseResult?.outputFile === 'string'
          ? String(toolUseResult.outputFile).trim()
          : typeof toolUseResult?.output_file === 'string'
            ? String(toolUseResult.output_file).trim()
            : null) ??
        (() => {
          if (!this.resolveJsonlPathForAgentId) return null;
          const claudeSessionId = this.resolveClaudeSessionId(message);
          return this.resolveJsonlPathForAgentId({ agentId, sidechainId: toolUseId, claudeSessionId });
        })();
      if (!outputFilePath) {
        // Session id/transcript path may not be known yet (init may arrive after Task spawns). Store a pending entry and
        // retry once we learn session_id (or when syncAll() is called).
        if (this.resolveJsonlPathForAgentId && !this.entriesBySidechainId.has(toolUseId)) {
          this.rememberPendingSidechain({ sidechainId: toolUseId, agentId, closeAfterRegister });
        }
        continue;
      }

      const registration = this.registerTaskOutputFile({
        sidechainId: toolUseId,
        agentId,
        outputFilePath,
        closeAfterRegister,
      });
      this.pendingRegistrations.add(registration);
      void registration.finally(() => this.pendingRegistrations.delete(registration));
    }
  }

  private extractAgentIdFromAgentToolUseInput(input: unknown): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const directAgentId =
      typeof record.agent_id === 'string'
        ? String(record.agent_id).trim()
        : typeof record.agentId === 'string'
          ? String(record.agentId).trim()
          : typeof record.teammate_id === 'string'
            ? String(record.teammate_id).trim()
            : typeof record.teammateId === 'string'
              ? String(record.teammateId).trim()
              : '';
    if (directAgentId.length > 0) return directAgentId;

    const name = typeof record.name === 'string' ? String(record.name).trim() : '';
    if (!name) return null;

    const teamName =
      typeof record.team_name === 'string'
        ? String(record.team_name).trim()
        : typeof record.teamName === 'string'
          ? String(record.teamName).trim()
          : typeof record.team_id === 'string'
            ? String(record.team_id).trim()
            : typeof record.teamId === 'string'
              ? String(record.teamId).trim()
              : typeof record.team === 'string'
                ? String(record.team).trim()
                : '';
    if (!teamName) return name.includes('@') ? name : null;
    return name.includes('@') ? name : `${name}@${teamName}`;
  }

  private async registerTaskOutputFile(params: {
    sidechainId: string;
    agentId: string | null;
    outputFilePath: string;
    closeAfterRegister: boolean;
  }): Promise<void> {
    if (this.disposed) return;
    if (this.entriesBySidechainId.has(params.sidechainId)) return;
    if (this.closedSidechainRecords.has(params.sidechainId)) return;
    if (!this.reserveSidechainRegistration(params.sidechainId)) return;
    const registrationGeneration = this.lifecycleGeneration;

    try {
      const resolvedJsonlPath = await (async () => {
        try {
          return await realpath(params.outputFilePath);
        } catch {
          return params.outputFilePath;
        }
      })();
      if (this.disposed || registrationGeneration !== this.lifecycleGeneration) return;

      const sidechainId = params.sidechainId;
      const agentId = params.agentId;

      const entry: Entry = {
        sidechainId,
        agentId,
        outputFilePath: params.outputFilePath,
        resolvedJsonlPath,
        closeTimer: null,
        closing: false,
        controller: createJsonlFollowController({
          filePath: resolvedJsonlPath,
          policy: this.followPolicy,
          watchFile: this.watchFile,
          onLine: (line) => this.ingestLine({ sidechainId, agentId, resolvedJsonlPath }, line),
        }),
      };

      this.entriesBySidechainId.set(params.sidechainId, entry);
      this.sidechainIdByJsonlPath.set(resolvedJsonlPath, params.sidechainId);

      // Initial import.
      await entry.controller.drainNow();
      void entry.controller.attach({ keepAlive: true });
      if (params.closeAfterRegister) {
        this.scheduleCompletedSidechainClose(params.sidechainId);
      }
    } finally {
      this.registeringSidechainIds.delete(params.sidechainId);
    }
  }

  private ingestLine(
    params: { sidechainId: string; agentId: string | null; resolvedJsonlPath: string },
    line: string,
  ): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    this.ingestJson(params, value);
  }

  private ingestJson(
    params: { sidechainId: string; agentId: string | null; resolvedJsonlPath: string },
    value: unknown,
  ): void {
    const parsed = parseRawJsonLinesObject(value);
    if (!parsed) return;

    // Skip the prompt root; remote launcher inserts a synthetic prompt root from Task tool_use.
    if (isClaudePromptRootSidechainUserMessage(parsed)) return;

    const uuid = typeof (parsed as any).uuid === 'string' ? String((parsed as any).uuid) : '';
    if (uuid) {
      const isDuplicate = markUuidSeenAndReturnIsDuplicate({
        seenUuidsBySidechainId: this.seenUuidsBySidechainId,
        sidechainId: params.sidechainId,
        uuid,
        maxSeenUuidsPerSidechain: configuration.claudeTaskOutputMaxSeenUuidsPerSidechain,
        maxSidechains: configuration.claudeTaskOutputMaxAgentMappings,
      });
      if (isDuplicate) return;
    }

    const terminal = isTerminalSidechainRecord(parsed);
    markClaudeRecordAsSidechain(parsed, params.sidechainId);

    this.emitImported(parsed, {
      importedFrom: 'claude-subagent-file',
      sidechainId: params.sidechainId,
      ...(params.agentId ? { claudeAgentId: params.agentId } : {}),
      claudeSubagentJsonlPath: params.resolvedJsonlPath,
    });

    if (terminal) {
      this.scheduleCompletedSidechainClose(params.sidechainId);
    }
  }

  private scheduleCompletedSidechainClose(sidechainId: string): void {
    const entry = this.entriesBySidechainId.get(sidechainId) ?? null;
    if (!entry || entry.closing || entry.closeTimer) return;
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = null;
      void this.closeEntryAfterFinalDrain(sidechainId, entry);
    }, this.followPolicy.sidechainCompletionGraceMs);
    entry.closeTimer.unref?.();
  }

  private async closeEntryAfterFinalDrain(sidechainId: string, entry: Entry): Promise<void> {
    const current = this.entriesBySidechainId.get(sidechainId) ?? null;
    if (current !== entry || entry.closing) return;
    entry.closing = true;

    try {
      await entry.controller.drainNow();
    } finally {
      this.sidechainIdByJsonlPath.delete(entry.resolvedJsonlPath);
      if (this.entriesBySidechainId.get(sidechainId) === entry) {
        this.entriesBySidechainId.delete(sidechainId);
      }
      this.rememberClosedSidechain(sidechainId, entry.resolvedJsonlPath);
      await entry.controller.dispose();
    }
  }

  private rememberClosedSidechain(sidechainId: string, resolvedJsonlPath: string): void {
    this.closedSidechainRecords.set(sidechainId, {
      resolvedJsonlPath,
      closedAtMs: Date.now(),
    });
    while (this.closedSidechainRecords.size > this.followPolicy.maxClosedFollowerRecordsPerSession) {
      const oldest = this.closedSidechainRecords.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.closedSidechainRecords.delete(oldest);
    }
  }

  private rememberPendingSidechain(entry: { sidechainId: string; agentId: string | null; closeAfterRegister: boolean }): void {
    const existing = this.pendingBySidechainId.get(entry.sidechainId);
    this.pendingBySidechainId.set(entry.sidechainId, {
      sidechainId: entry.sidechainId,
      agentId: entry.agentId ?? existing?.agentId ?? null,
      closeAfterRegister: entry.closeAfterRegister || existing?.closeAfterRegister === true,
    });
    while (this.pendingBySidechainId.size > this.followPolicy.maxIdleFollowersPerSession) {
      const oldest = this.pendingBySidechainId.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.pendingBySidechainId.delete(oldest);
    }
  }

  private reserveSidechainRegistration(sidechainId: string): boolean {
    if (this.entriesBySidechainId.has(sidechainId)) return false;
    if (this.closedSidechainRecords.has(sidechainId)) return false;
    const maxOpenFollowers = Math.min(
      this.followPolicy.maxActiveFollowersPerSession,
      this.followPolicy.maxIdleFollowersPerSession,
    );
    if (this.entriesBySidechainId.size + this.registeringSidechainIds.size >= maxOpenFollowers) {
      return false;
    }
    this.registeringSidechainIds.add(sidechainId);
    return true;
  }

  private observeClaudeSessionId(message: SDKMessage): void {
    const raw = (message as any)?.session_id ?? (message as any)?.sessionId;
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    if (!value) return;
    const prev = this.lastClaudeSessionId;
    this.lastClaudeSessionId = value;
    if (prev !== value) {
      this.flushPendingRegistrations();
    }
  }

  private resolveClaudeSessionId(message: SDKMessage): string | null {
    const raw = (message as any)?.sessionId ?? (message as any)?.session_id;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    return this.lastClaudeSessionId;
  }

  private flushPendingRegistrations(): void {
    if (this.disposed) return;
    if (!this.resolveJsonlPathForAgentId) return;
    const claudeSessionId = this.lastClaudeSessionId;
    if (!claudeSessionId) return;

    for (const pending of this.pendingBySidechainId.values()) {
      if (this.entriesBySidechainId.has(pending.sidechainId)) {
        this.pendingBySidechainId.delete(pending.sidechainId);
        continue;
      }

      const outputFilePath = this.resolveJsonlPathForAgentId({
        agentId: pending.agentId,
        sidechainId: pending.sidechainId,
        claudeSessionId,
      });
      if (!outputFilePath) continue;

      this.pendingBySidechainId.delete(pending.sidechainId);
      const registration = this.registerTaskOutputFile({
        sidechainId: pending.sidechainId,
        agentId: pending.agentId,
        outputFilePath,
        closeAfterRegister: pending.closeAfterRegister,
      });
      this.pendingRegistrations.add(registration);
      void registration.finally(() => this.pendingRegistrations.delete(registration));
    }
  }
}

function isTerminalSidechainRecord(record: RawJSONLines): boolean {
  if (record.type !== 'assistant') return false;
  const message = (record as any).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const stopReason = (message as any).stop_reason ?? (message as any).stopReason;
  return typeof stopReason === 'string' && stopReason.trim().length > 0;
}

function shouldCloseSidechainAfterParentToolResult(params: Readonly<{
  toolName: string;
  toolUseResult: unknown;
}>): boolean {
  if (params.toolName === 'Task') return true;
  const status = readToolUseResultStatus(params.toolUseResult);
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'canceled';
}

function readToolUseResultStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw = record.status ?? record.state;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : null;
}
