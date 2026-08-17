import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { RawJSONLines } from '@/backends/claude/types';
import { configuration } from '@/configuration';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { parseRawJsonLinesObject } from '@/backends/claude/utils/parseRawJsonLines';
import type { JsonlFollowerMetricEvent } from '@/agent/localControl/jsonlFollowMetrics';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

import { extractAgentIdFromTaskResultText } from './extractAgentIdFromTaskResult';
import {
  coerceToolResultText,
  extractOutputFilePathFromTaskResultText,
  isPromptRootUserMessage,
  markRecordAsSidechain,
  markUuidSeenAndReturnIsDuplicate,
  LruSet,
} from './_shared';
import {
  createClaudeJsonlResetReplaySuppressor,
  type ClaudeJsonlResetReplaySuppressor,
} from '../../utils/claudeJsonlReplaySuppression';

import { realpath } from 'node:fs/promises';
import { createJsonlFollowController, type JsonlFollowController } from '@/agent/localControl/jsonlFollowController';
import { normalizeJsonlFollowPolicy, type JsonlFollowPolicyInput, type JsonlFollowPolicyV1 } from '@/agent/localControl/jsonlFollowPolicy';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
import { isClaudeAsyncAgentLaunchToolResult } from '@happier-dev/protocol';
import { normalizeClaudeAgentSdkProviderTaskId } from '../../providerActivity/createClaudeProviderActivityLedger';

type WatchFile = (file: string, onFileChange: (file: string) => void) => () => void;

type EmitImported = (body: RawJSONLines, meta: Record<string, unknown>) => void;

export type ClaudeRemoteSubagentFileActivity = Readonly<{
  status: 'active' | 'terminal';
  sidechainId: string;
  agentId: string;
  providerTaskIds: readonly string[];
  resolvedJsonlPath: string;
}>;

type ResolveJsonlPathForAgentId = (params: {
  agentId: string;
  sidechainId: string;
  claudeSessionId: string | null;
}) => string | null;

/**
 * How this collector came to hold a file — the ONLY thing that differs between its two callers.
 *
 * - `task-tool`: discovered by observing a `Task`/`Agent` tool use and resolving the agent's JSONL.
 *   The sidechain id is the tool-use id, and the remote launcher synthesises a prompt root from
 *   that tool use.
 * - `workflow-agent`: handed over by a caller that already holds the file. A workflow run has ONE
 *   `Workflow` tool call and many `agent-<id>.jsonl` sidecars, so there is no per-agent tool call to
 *   discover, no tool-use id to key on, and nothing that synthesises a prompt root.
 *
 * Everything past registration — follow, dedupe, mark, emit — is one path for both.
 */
export type ClaudeSidechainImportSource = 'task-tool' | 'workflow-agent';

type Entry = {
  sidechainId: string; // Task tool_use id
  agentId: string;
  source: ClaudeSidechainImportSource;
  providerTaskIds: readonly string[];
  outputFilePath: string;
  resolvedJsonlPath: string;
  controller: JsonlFollowController;
  createdAtMs: number;
  lastTouchedAtMs: number;
  didEmitTerminalSourceActivity: boolean;
};

type PendingRegistration = {
  sidechainId: string;
  agentId: string;
  providerTaskIds: readonly string[];
  markCompletedAfterRegister: boolean;
};

export class ClaudeRemoteSubagentFileCollector {
  private readonly emitImported: EmitImported;
  private readonly watchFile: WatchFile;
  private readonly resolveJsonlPathForAgentId: ResolveJsonlPathForAgentId | null;
  private readonly onSourceActivity: ((activity: ClaudeRemoteSubagentFileActivity) => void) | null;

  private lastClaudeSessionId: string | null = null;
  private toolNameByToolUseId = new Map<string, string>();
  private agentIdByToolUseId = new Map<string, string>();
  private pendingRegistrations = new Set<Promise<void>>();
  private readonly pendingBySidechainId = new Map<string, PendingRegistration>();
  private readonly entriesBySidechainId = new Map<string, Entry>();
  private readonly closedSidechainIds = new Map<string, number>();
  private readonly seenUuidsBySidechainId = new Map<string, LruSet>();
  private readonly followPolicy: JsonlFollowPolicyV1;

  constructor(opts: {
    emitImported: EmitImported;
    watchFile?: WatchFile;
    resolveJsonlPathForAgentId?: ResolveJsonlPathForAgentId;
    onSourceActivity?: (activity: ClaudeRemoteSubagentFileActivity) => void;
    followPolicy?: JsonlFollowPolicyInput;
  }) {
    this.emitImported = opts.emitImported;
    this.watchFile = opts.watchFile ?? startFileWatcher;
    this.resolveJsonlPathForAgentId = opts.resolveJsonlPathForAgentId ?? null;
    this.onSourceActivity = opts.onSourceActivity ?? null;
    this.followPolicy = normalizeJsonlFollowPolicy(opts.followPolicy);
  }

  observe(message: SDKMessage): void {
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
    for (const entry of this.entriesBySidechainId.values()) {
      this.emitTerminalSourceActivity(entry);
      void entry.controller.stop();
    }
    this.entriesBySidechainId.clear();
    this.closedSidechainIds.clear();
    this.toolNameByToolUseId.clear();
    this.agentIdByToolUseId.clear();
    this.seenUuidsBySidechainId.clear();
  }

  async syncAll(): Promise<void> {
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

      const toolUseId = readNonBlankOpaqueIdentifier((item as any).id) ?? '';
      const toolName = String((item as any).name ?? '').trim();
      if (!toolUseId || !toolName) continue;
      if (this.closedSidechainIds.has(toolUseId)) continue;
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
        this.pendingBySidechainId.set(toolUseId, {
          sidechainId: toolUseId,
          agentId: agentIdFromInput || toolUseId,
          providerTaskIds: buildProviderTaskIdCandidates({
            toolUseResult: null,
            agentId: agentIdFromInput || toolUseId,
            sidechainId: toolUseId,
          }),
          markCompletedAfterRegister: false,
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

      const toolUseId = readNonBlankOpaqueIdentifier((item as any).tool_use_id) ?? '';
      if (!toolUseId) continue;
      if (this.closedSidechainIds.has(toolUseId)) continue;

      const toolName = this.toolNameByToolUseId.get(toolUseId) ?? null;
      // Execution runs and Claude agent teams both surface sub-agent transcripts as JSONL files.
      // - `Task` tool results often include `output_file`
      // - `Agent` (agent-teams) tool results typically do not, so we resolve by agent_id + session_id
      if (!toolName || !isGenericSubAgentToolName(toolName)) continue;

      const toolResultText = coerceToolResultText(
        toolUseResult !== undefined ? { content: (item as any).content, tool_use_result: toolUseResult } : (item as any).content,
      );
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
      const providerTaskIds = buildProviderTaskIdCandidates({
        toolUseResult,
        agentId,
        sidechainId: toolUseId,
      });

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
      const shouldMarkCompleted = shouldMarkSidechainCompletedAfterToolResult({ toolName, toolUseResult });

      if (!outputFilePath) {
        // Session id/transcript path may not be known yet (init may arrive after Task spawns). Store a pending entry and
        // retry once we learn session_id (or when syncAll() is called).
        if (this.resolveJsonlPathForAgentId && !this.entriesBySidechainId.has(toolUseId)) {
          this.pendingBySidechainId.set(toolUseId, {
            sidechainId: toolUseId,
            agentId,
            providerTaskIds,
            markCompletedAfterRegister: shouldMarkCompleted,
          });
        } else if (shouldMarkCompleted) {
          this.markEntryCompleted(toolUseId);
        }
        continue;
      }

      const registration = this.registerTaskOutputFile({
        sidechainId: toolUseId,
        agentId,
        providerTaskIds,
        outputFilePath,
        markCompletedAfterRegister: shouldMarkCompleted,
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

  /**
   * Import a sidechain whose file the CALLER already resolved.
   *
   * The workflow journal follower is the one caller: it is already holding the run's sidecar
   * directory, so it knows `agent-<agentId>.jsonl` exists before any tool call could tell us. It
   * hands the file over here rather than importing it itself, so workflow agent transcripts and
   * `Task` subagent transcripts are produced by ONE importer with one dedupe, one follower cap and
   * one marking rule.
   *
   * The `sidechainId` is minted by the protocol owner (`buildWorkflowAgentSidechainId`) and passed
   * in whole; this class never composes one.
   */
  async registerSidechainFile(params: Readonly<{
    sidechainId: string;
    agentId: string;
    filePath: string;
    source: ClaudeSidechainImportSource;
  }>): Promise<void> {
    const sidechainId = readNonBlankOpaqueIdentifier(params.sidechainId) ?? '';
    const agentId = String(params.agentId ?? '').trim();
    const filePath = String(params.filePath ?? '').trim();
    if (!sidechainId || !agentId || !filePath) return;

    const registration = this.registerTaskOutputFile({
      sidechainId,
      agentId,
      source: params.source,
      providerTaskIds: buildProviderTaskIdCandidates({ toolUseResult: null, agentId, sidechainId }),
      outputFilePath: filePath,
    });
    this.pendingRegistrations.add(registration);
    void registration.finally(() => this.pendingRegistrations.delete(registration));
    await registration;
  }

  private async registerTaskOutputFile(params: {
    sidechainId: string;
    agentId: string;
    providerTaskIds: readonly string[];
    outputFilePath: string;
    source?: ClaudeSidechainImportSource;
    markCompletedAfterRegister?: boolean;
  }): Promise<void> {
    const existing = this.entriesBySidechainId.get(params.sidechainId);
    if (existing) {
      if (params.markCompletedAfterRegister) {
        this.markEntryCompleted(params.sidechainId);
      }
      return;
    }
    if (this.closedSidechainIds.has(params.sidechainId)) return;

    const resolvedJsonlPath = await (async () => {
      try {
        return await realpath(params.outputFilePath);
      } catch {
        return params.outputFilePath;
      }
    })();

    const sidechainId = params.sidechainId;
    const agentId = params.agentId;
    const source: ClaudeSidechainImportSource = params.source ?? 'task-tool';
    const replaySuppressor = createClaudeJsonlResetReplaySuppressor();
    const handleFollowerMetric = (event: JsonlFollowerMetricEvent): void => {
      if (event.type !== 'file_reset') return;
      replaySuppressor.markReset();
    };

    const now = Date.now();
    const entry: Entry = {
      sidechainId,
      agentId,
      source,
      providerTaskIds: params.providerTaskIds,
      outputFilePath: params.outputFilePath,
      resolvedJsonlPath,
      createdAtMs: now,
      lastTouchedAtMs: now,
      controller: createJsonlFollowController({
        filePath: resolvedJsonlPath,
        pollPolicy: this.followPolicy,
        watchFile: this.watchFile,
        metrics: { emit: handleFollowerMetric },
        onClosed: () => this.closeEntry(sidechainId),
        onJson: (value) => this.ingestJson({
          sidechainId,
          agentId,
          source,
          providerTaskIds: params.providerTaskIds,
          resolvedJsonlPath,
        }, value, { replaySuppressor }),
      }),
      didEmitTerminalSourceActivity: false,
    };

    this.entriesBySidechainId.set(params.sidechainId, entry);

    await entry.controller.start();
    this.enforceFollowerCaps();
    if (params.markCompletedAfterRegister) {
      this.markEntryCompleted(params.sidechainId);
    }
  }

  private markEntryCompleted(sidechainId: string): void {
    const entry = this.entriesBySidechainId.get(sidechainId);
    entry?.controller.markCompleted();
  }

  private closeEntry(sidechainId: string): void {
    const entry = this.entriesBySidechainId.get(sidechainId);
    if (entry) {
      this.emitTerminalSourceActivity(entry);
    }
    this.entriesBySidechainId.delete(sidechainId);
    this.seenUuidsBySidechainId.delete(sidechainId);
    this.rememberClosedSidechainId(sidechainId);
  }

  private emitSourceActivity(
    entry: Readonly<Pick<Entry, 'sidechainId' | 'agentId' | 'providerTaskIds' | 'resolvedJsonlPath'>>,
    status: ClaudeRemoteSubagentFileActivity['status'],
  ): void {
    this.onSourceActivity?.({
      status,
      sidechainId: entry.sidechainId,
      agentId: entry.agentId,
      providerTaskIds: entry.providerTaskIds,
      resolvedJsonlPath: entry.resolvedJsonlPath,
    });
  }

  private emitTerminalSourceActivity(entry: Entry): void {
    if (entry.didEmitTerminalSourceActivity) return;
    entry.didEmitTerminalSourceActivity = true;
    this.emitSourceActivity(entry, 'terminal');
  }

  private rememberClosedSidechainId(sidechainId: string): void {
    this.closedSidechainIds.delete(sidechainId);
    this.closedSidechainIds.set(sidechainId, Date.now());
    while (this.closedSidechainIds.size > this.followPolicy.maxClosedFollowerRecordsPerSession) {
      const oldest = this.closedSidechainIds.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.closedSidechainIds.delete(oldest);
    }
  }

  private enforceFollowerCaps(): void {
    const activeEntries = [...this.entriesBySidechainId.values()]
      .filter((entry) => entry.controller.getState() === 'active')
      .sort(compareEntriesForEviction);
    while (activeEntries.length > this.followPolicy.maxActiveFollowersPerSession) {
      const entry = activeEntries.shift();
      entry?.controller.markIdle();
    }

    const idleEntries = [...this.entriesBySidechainId.values()]
      .filter((entry) => entry.controller.getState() === 'idle')
      .sort(compareEntriesForEviction);
    while (idleEntries.length > this.followPolicy.maxIdleFollowersPerSession) {
      const entry = idleEntries.shift();
      if (!entry) break;
      void entry.controller.stop();
    }
  }

  private ingestJson(
    params: {
      sidechainId: string;
      agentId: string;
      source: ClaudeSidechainImportSource;
      providerTaskIds: readonly string[];
      resolvedJsonlPath: string;
    },
    value: unknown,
    opts?: { replaySuppressor?: ClaudeJsonlResetReplaySuppressor },
  ): void {
    if (opts?.replaySuppressor?.shouldSuppress(value)) return;

    const parsed = parseRawJsonLinesObject(value);
    if (!parsed) return;

    const entry = this.entriesBySidechainId.get(params.sidechainId);
    if (entry) {
      entry.lastTouchedAtMs = Date.now();
    }

    // Skip the prompt root; remote launcher inserts a synthetic prompt root from Task tool_use.
    // That reason is Task-specific and does not hold for a workflow agent: it has no tool call, so
    // nothing synthesises a root, and skipping would drop the one record saying what it was asked.
    if (params.source === 'task-tool' && isPromptRootUserMessage(parsed)) return;

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

    markRecordAsSidechain(parsed, params.sidechainId);

    this.emitSourceActivity(params, 'active');

    this.emitImported(parsed, {
      importedFrom: 'claude-subagent-file',
      sidechainId: params.sidechainId,
      claudeAgentId: params.agentId,
      claudeSubagentJsonlPath: params.resolvedJsonlPath,
    });
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
    if (!this.resolveJsonlPathForAgentId) return;
    const claudeSessionId = this.lastClaudeSessionId;
    if (!claudeSessionId) return;

    for (const pending of this.pendingBySidechainId.values()) {
      if (this.closedSidechainIds.has(pending.sidechainId)) {
        this.pendingBySidechainId.delete(pending.sidechainId);
        continue;
      }
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
        providerTaskIds: pending.providerTaskIds,
        outputFilePath,
        markCompletedAfterRegister: pending.markCompletedAfterRegister,
      });
      this.pendingRegistrations.add(registration);
      void registration.finally(() => this.pendingRegistrations.delete(registration));
    }
  }
}

function addProviderTaskCandidate(candidates: string[], value: unknown): void {
  const normalized = normalizeClaudeAgentSdkProviderTaskId(value);
  if (!normalized || candidates.includes(normalized)) return;
  candidates.push(normalized);
}

function buildProviderTaskIdCandidates(params: {
  toolUseResult: unknown;
  agentId: string;
  sidechainId: string;
}): readonly string[] {
  const candidates: string[] = [];
  const result = params.toolUseResult && typeof params.toolUseResult === 'object' && !Array.isArray(params.toolUseResult)
    ? params.toolUseResult as Record<string, unknown>
    : null;
  if (result) {
    addProviderTaskCandidate(candidates, result.backgroundTaskId);
    addProviderTaskCandidate(candidates, result.background_task_id);
    addProviderTaskCandidate(candidates, result.taskId);
    addProviderTaskCandidate(candidates, result.task_id);
    addProviderTaskCandidate(candidates, result.agentId);
    addProviderTaskCandidate(candidates, result.agent_id);
    addProviderTaskCandidate(candidates, result.teammateId);
    addProviderTaskCandidate(candidates, result.teammate_id);
  }
  addProviderTaskCandidate(candidates, params.agentId);
  addProviderTaskCandidate(candidates, params.sidechainId);
  return candidates;
}

function shouldMarkSidechainCompletedAfterToolResult(params: {
  toolName: string;
  toolUseResult: any;
}): boolean {
  // A launch acknowledgement is not a completion, whichever name the tool carries. `Task` used to be
  // synchronous, so its result was its answer; closing the follower on an ASYNC launch abandons the
  // live transcript for the agent's entire run.
  if (isClaudeAsyncAgentLaunchToolResult(params.toolUseResult)) return false;
  if (params.toolName === 'Task') return true;
  const status = typeof params.toolUseResult?.status === 'string' ? String(params.toolUseResult.status).trim().toLowerCase() : '';
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled';
}

function compareEntriesForEviction(left: Entry, right: Entry): number {
  return (left.lastTouchedAtMs - right.lastTouchedAtMs) || (left.createdAtMs - right.createdAtMs);
}
