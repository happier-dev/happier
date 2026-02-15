import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '../../sdk';

import type { ClaudeTaskOutputImportedMessage, ClaudeTaskOutputToolResultSummary } from './claudeTaskOutputSidechainImporter';
import { ClaudeTaskOutputSidechainImporter } from './claudeTaskOutputSidechainImporter';
import { coerceToolResultText } from './_shared';

export type ClaudeRemoteTaskOutputCollectorObservation = {
  imported: ClaudeTaskOutputImportedMessage[];
  taskOutputToolResults: ClaudeTaskOutputToolResultSummary[];
};

export class ClaudeRemoteTaskOutputCollector {
  private readonly importer = new ClaudeTaskOutputSidechainImporter();

  observe(message: SDKMessage): ClaudeRemoteTaskOutputCollectorObservation {
    if ((message as any)?.type === 'assistant') {
      this.observeAssistantToolUses(message as SDKAssistantMessage);
      return { imported: [], taskOutputToolResults: [] };
    }

    if ((message as any)?.type === 'user') {
      return this.observeUserToolResults(message as SDKUserMessage);
    }

    return { imported: [], taskOutputToolResults: [] };
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

      this.importer.observeToolUse({ toolUseId, toolName, input: (item as any).input });
    }
  }

  private observeUserToolResults(message: SDKUserMessage): ClaudeRemoteTaskOutputCollectorObservation {
    const content = (message as any)?.message?.content;
    if (!Array.isArray(content)) return { imported: [], taskOutputToolResults: [] };

    const imported: ClaudeTaskOutputImportedMessage[] = [];
    const taskOutputToolResults: ClaudeTaskOutputToolResultSummary[] = [];

    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as any).type !== 'tool_result') continue;

      const toolUseId = String((item as any).tool_use_id ?? '').trim();
      if (!toolUseId) continue;

      const toolResultText = coerceToolResultText((item as any).content);
      const result = this.importer.ingestToolResult({ toolUseId, toolResultText });
      imported.push(...result.imported);

      if (result.taskOutputSummary) taskOutputToolResults.push(result.taskOutputSummary);
    }

    return { imported, taskOutputToolResults };
  }
}
