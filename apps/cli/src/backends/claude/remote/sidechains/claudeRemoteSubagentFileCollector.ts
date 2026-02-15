import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { RawJSONLines } from '@/backends/claude/types';
import { configuration } from '@/configuration';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { parseRawJsonLinesObject } from '@/backends/claude/utils/parseRawJsonLines';

import { extractAgentIdFromTaskResultText } from './extractAgentIdFromTaskResult';
import {
  coerceToolResultText,
  extractOutputFilePathFromTaskResultText,
  isPromptRootUserMessage,
  markRecordAsSidechain,
  markUuidSeenAndReturnIsDuplicate,
  LruSet,
} from './_shared';

import { realpath } from 'node:fs/promises';
import { JsonlFollower } from '@/agent/localControl/jsonlFollower';

type WatchFile = (file: string, onFileChange: (file: string) => void) => () => void;

type EmitImported = (body: RawJSONLines, meta: Record<string, unknown>) => void;

type ResolveJsonlPathForAgentId = (params: {
  agentId: string;
  sidechainId: string;
  claudeSessionId: string | null;
}) => string | null;

type Entry = {
  sidechainId: string; // Task tool_use id
  agentId: string;
  outputFilePath: string;
  resolvedJsonlPath: string;
  stopWatcher: (() => void) | null;
  follower: JsonlFollower;
};

export class ClaudeRemoteSubagentFileCollector {
  private readonly emitImported: EmitImported;
  private readonly watchFile: WatchFile;
  private readonly resolveJsonlPathForAgentId: ResolveJsonlPathForAgentId | null;

  private lastClaudeSessionId: string | null = null;
  private toolNameByToolUseId = new Map<string, string>();
  private pendingRegistrations = new Set<Promise<void>>();
  private readonly entriesBySidechainId = new Map<string, Entry>();
  private readonly sidechainIdByJsonlPath = new Map<string, string>();
  private readonly seenUuidsBySidechainId = new Map<string, LruSet>();

  constructor(opts: {
    emitImported: EmitImported;
    watchFile?: WatchFile;
    resolveJsonlPathForAgentId?: ResolveJsonlPathForAgentId;
  }) {
    this.emitImported = opts.emitImported;
    this.watchFile = opts.watchFile ?? startFileWatcher;
    this.resolveJsonlPathForAgentId = opts.resolveJsonlPathForAgentId ?? null;
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
      entry.stopWatcher?.();
      entry.stopWatcher = null;
      void entry.follower.stop();
    }
    this.entriesBySidechainId.clear();
    this.sidechainIdByJsonlPath.clear();
    this.toolNameByToolUseId.clear();
    this.seenUuidsBySidechainId.clear();
  }

  async syncAll(): Promise<void> {
    if (this.pendingRegistrations.size > 0) {
      // Ensure we don't miss an initial import in the same tick as Task tool_result observation.
      await Promise.allSettled([...this.pendingRegistrations]);
    }
    for (const entry of this.entriesBySidechainId.values()) {
      await entry.follower.drainNow();
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
    }
  }

  private observeUserToolResults(message: SDKUserMessage): void {
    const content = (message as any)?.message?.content;
    if (!Array.isArray(content)) return;

    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as any).type !== 'tool_result') continue;

      const toolUseId = String((item as any).tool_use_id ?? '').trim();
      if (!toolUseId) continue;

      const toolName = this.toolNameByToolUseId.get(toolUseId) ?? null;
      if (toolName !== 'Task') continue;

      const toolResultText = coerceToolResultText((item as any).content);
      const ids = extractAgentIdFromTaskResultText(toolResultText);
      const agentId =
        (ids.agentId ? String(ids.agentId).trim() : '') ||
        (typeof (message as any)?.toolUseResult?.agentId === 'string'
          ? String((message as any).toolUseResult.agentId).trim()
          : '');
      if (!agentId) continue;

      const outputFilePath =
        extractOutputFilePathFromTaskResultText(toolResultText) ??
        (typeof (message as any)?.toolUseResult?.outputFile === 'string'
          ? String((message as any).toolUseResult.outputFile).trim()
          : typeof (message as any)?.toolUseResult?.output_file === 'string'
            ? String((message as any).toolUseResult.output_file).trim()
            : null) ??
        (() => {
          if (!this.resolveJsonlPathForAgentId) return null;
          const claudeSessionId = this.resolveClaudeSessionId(message);
          return this.resolveJsonlPathForAgentId({ agentId, sidechainId: toolUseId, claudeSessionId });
        })();
      if (!outputFilePath) continue;

      const registration = this.registerTaskOutputFile({
        sidechainId: toolUseId,
        agentId,
        outputFilePath,
      });
      this.pendingRegistrations.add(registration);
      void registration.finally(() => this.pendingRegistrations.delete(registration));
    }
  }

  private async registerTaskOutputFile(params: {
    sidechainId: string;
    agentId: string;
    outputFilePath: string;
  }): Promise<void> {
    if (this.entriesBySidechainId.has(params.sidechainId)) return;

    const resolvedJsonlPath = await (async () => {
      try {
        return await realpath(params.outputFilePath);
      } catch {
        return params.outputFilePath;
      }
    })();

    const sidechainId = params.sidechainId;
    const agentId = params.agentId;

    const entry: Entry = {
      sidechainId,
      agentId,
      outputFilePath: params.outputFilePath,
      resolvedJsonlPath,
      stopWatcher: null,
      follower: new JsonlFollower({
        filePath: resolvedJsonlPath,
        pollIntervalMs: configuration.claudeSubagentJsonlPollIntervalMs,
        onJson: (value) => this.ingestJson({ sidechainId, agentId, resolvedJsonlPath }, value),
      }),
    };

    this.entriesBySidechainId.set(params.sidechainId, entry);
    this.sidechainIdByJsonlPath.set(resolvedJsonlPath, params.sidechainId);

    entry.stopWatcher = this.watchFile(resolvedJsonlPath, (file) => {
      const sidechainId = this.sidechainIdByJsonlPath.get(file) ?? null;
      if (!sidechainId) return;
      const target = this.entriesBySidechainId.get(sidechainId) ?? null;
      if (!target) return;
      void target.follower.drainNow();
    });

    // Initial import.
    await entry.follower.drainNow();
    void entry.follower.start();
  }

  private ingestJson(
    params: { sidechainId: string; agentId: string; resolvedJsonlPath: string },
    value: unknown,
  ): void {
    const parsed = parseRawJsonLinesObject(value);
    if (!parsed) return;

    // Skip the prompt root; remote launcher inserts a synthetic prompt root from Task tool_use.
    if (isPromptRootUserMessage(parsed)) return;

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
    this.lastClaudeSessionId = value;
  }

  private resolveClaudeSessionId(message: SDKMessage): string | null {
    const raw = (message as any)?.sessionId ?? (message as any)?.session_id;
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    return this.lastClaudeSessionId;
  }
}
