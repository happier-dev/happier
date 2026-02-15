import type { RawJSONLines } from '@/backends/claude/types';
import { configuration } from '@/configuration';

import { extractAgentIdFromTaskResultText } from './extractAgentIdFromTaskResult';
import { parseTaskOutputJsonlText } from './parseTaskOutputJsonl';
import { isPromptRootUserMessage, markRecordAsSidechain, markUuidSeenAndReturnIsDuplicate, LruSet, setBoundedMap } from './_shared';

type ClaudeTaskOutputSidechainImporterLimits = {
  maxPendingRecordsPerAgent: number;
  maxSeenUuidsPerSidechain: number;
  maxToolUseEntries: number;
  maxAgentMappings: number;
};

type ObserveToolUseParams = {
  toolUseId: string;
  toolName: string;
  input: unknown;
};

type IngestToolResultParams = {
  toolUseId: string;
  toolResultText: string;
};

export type ClaudeTaskOutputImportedMessage = {
  body: RawJSONLines;
  meta: Record<string, unknown>;
};

export type ClaudeTaskOutputToolResultSummary = {
  toolUseId: string;
  taskId: string | null;
  importedCount: number;
  bufferedCount: number;
};

type IngestToolResultResult = {
  imported: ClaudeTaskOutputImportedMessage[];
  taskOutputSummary: ClaudeTaskOutputToolResultSummary | null;
};

type PendingTaskOutputRecord = {
  record: RawJSONLines;
  taskOutputToolUseId: string;
};

function buildImportedMeta(params: {
  taskOutputToolUseId: string;
  taskId: string | null;
  agentId: string;
  remoteSessionId: string | null;
}): Record<string, unknown> {
  return {
    importedFrom: 'claude-taskoutput',
    claudeTaskOutputToolUseId: params.taskOutputToolUseId,
    claudeTaskId: params.taskId,
    claudeAgentId: params.agentId,
    claudeRemoteSessionId: params.remoteSessionId,
  };
}

export class ClaudeTaskOutputSidechainImporter {
  private readonly limits: ClaudeTaskOutputSidechainImporterLimits;
  private toolNameByToolUseId = new Map<string, string>();
  private taskIdByToolUseId = new Map<string, string>();

  private sidechainIdByAgentId = new Map<string, string>(); // agentId -> Task tool_use id
  private pendingByAgentId = new Map<string, PendingTaskOutputRecord[]>();
  private seenUuidsBySidechainId = new Map<string, LruSet>();

  constructor(limits?: Partial<ClaudeTaskOutputSidechainImporterLimits>) {
    this.limits = {
      maxPendingRecordsPerAgent: limits?.maxPendingRecordsPerAgent ?? configuration.claudeTaskOutputMaxPendingPerAgent,
      maxSeenUuidsPerSidechain: limits?.maxSeenUuidsPerSidechain ?? configuration.claudeTaskOutputMaxSeenUuidsPerSidechain,
      maxToolUseEntries: limits?.maxToolUseEntries ?? configuration.claudeTaskOutputMaxToolUseEntries,
      maxAgentMappings: limits?.maxAgentMappings ?? configuration.claudeTaskOutputMaxAgentMappings,
    };
  }

  observeToolUse(params: ObserveToolUseParams): void {
    const toolUseId = String(params.toolUseId ?? '').trim();
    const toolName = String(params.toolName ?? '').trim();
    if (!toolUseId || !toolName) return;

    setBoundedMap(this.toolNameByToolUseId, toolUseId, toolName, this.limits.maxToolUseEntries);

    if (toolName === 'TaskOutput') {
      const input = params.input as any;
      const taskId = typeof input?.task_id === 'string' ? input.task_id.trim() : '';
      if (taskId) {
        setBoundedMap(this.taskIdByToolUseId, toolUseId, taskId, this.limits.maxToolUseEntries);
      }
    }
  }

  ingestToolResult(params: IngestToolResultParams): IngestToolResultResult {
    const toolUseId = String(params.toolUseId ?? '').trim();
    if (!toolUseId) return { imported: [], taskOutputSummary: null };

    const toolName = this.toolNameByToolUseId.get(toolUseId) ?? null;
    if (toolName === 'Task') {
      return { imported: this.ingestTaskToolResult({ taskToolUseId: toolUseId, toolResultText: params.toolResultText }), taskOutputSummary: null };
    }
    if (toolName === 'TaskOutput') {
      const { imported, bufferedCount } = this.ingestTaskOutputToolResult({ taskOutputToolUseId: toolUseId, toolResultText: params.toolResultText });
      return {
        imported,
        taskOutputSummary: {
          toolUseId,
          taskId: this.taskIdByToolUseId.get(toolUseId) ?? null,
          importedCount: imported.length,
          bufferedCount,
        },
      };
    }

    return { imported: [], taskOutputSummary: null };
  }

  private ingestTaskToolResult(params: { taskToolUseId: string; toolResultText: string }): ClaudeTaskOutputImportedMessage[] {
    const ids = extractAgentIdFromTaskResultText(params.toolResultText);
    if (!ids.agentId) return [];

    setBoundedMap(this.sidechainIdByAgentId, ids.agentId, params.taskToolUseId, this.limits.maxAgentMappings);

    const pending = this.pendingByAgentId.get(ids.agentId) ?? [];
    if (pending.length === 0) return [];

    this.pendingByAgentId.delete(ids.agentId);
    return this.importRecords(params.taskToolUseId, pending);
  }

  private ingestTaskOutputToolResult(params: {
    taskOutputToolUseId: string;
    toolResultText: string;
  }): { imported: ClaudeTaskOutputImportedMessage[]; bufferedCount: number } {
    const records = parseTaskOutputJsonlText(params.toolResultText);
    if (records.length === 0) return { imported: [], bufferedCount: 0 };

    const imported: ClaudeTaskOutputImportedMessage[] = [];
    let bufferedCount = 0;

    for (const record of records) {
      const agentId = typeof (record as any).agentId === 'string' ? String((record as any).agentId) : null;
      if (!agentId) {
        continue;
      }

      const sidechainId = this.sidechainIdByAgentId.get(agentId) ?? null;
      if (!sidechainId) {
        const next = this.pendingByAgentId.get(agentId) ?? [];
        next.push({ record, taskOutputToolUseId: params.taskOutputToolUseId });
        bufferedCount += 1;

        const maxPending = Math.max(0, Math.floor(this.limits.maxPendingRecordsPerAgent));
        if (maxPending === 0) {
          next.length = 0;
        } else if (next.length > maxPending) {
          next.splice(0, next.length - maxPending);
        }

        setBoundedMap(this.pendingByAgentId, agentId, next, this.limits.maxAgentMappings);
        continue;
      }

      imported.push(...this.importRecords(sidechainId, [{ record, taskOutputToolUseId: params.taskOutputToolUseId }]));
    }

    return { imported, bufferedCount };
  }

  private importRecords(sidechainId: string, records: PendingTaskOutputRecord[]): ClaudeTaskOutputImportedMessage[] {
    const imported: ClaudeTaskOutputImportedMessage[] = [];

    for (const pending of records) {
      const record = pending.record;
      const uuid = typeof (record as any).uuid === 'string' ? String((record as any).uuid) : '';
      if (!uuid) continue;
      const isDuplicate = markUuidSeenAndReturnIsDuplicate({
        seenUuidsBySidechainId: this.seenUuidsBySidechainId,
        sidechainId,
        uuid,
        maxSeenUuidsPerSidechain: this.limits.maxSeenUuidsPerSidechain,
        maxSidechains: this.limits.maxAgentMappings,
      });
      if (isDuplicate) continue;

      if (isPromptRootUserMessage(record)) {
        continue;
      }

      const agentId = typeof (record as any).agentId === 'string' ? String((record as any).agentId) : null;
      if (!agentId) continue;

      const remoteSessionId = typeof (record as any).sessionId === 'string' ? String((record as any).sessionId) : null;
      const taskId = this.taskIdByToolUseId.get(pending.taskOutputToolUseId) ?? null;

      imported.push({
        body: markRecordAsSidechain(record, sidechainId),
        meta: buildImportedMeta({
          taskOutputToolUseId: pending.taskOutputToolUseId,
          taskId,
          agentId,
          remoteSessionId,
        }),
      });
    }

    return imported;
  }
}
