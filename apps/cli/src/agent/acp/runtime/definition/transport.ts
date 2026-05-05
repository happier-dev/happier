import { DefaultTransport, type TransportHandler } from '@/agent/transport';

import type { AcpRuntimeDefinitionV1 } from './_types';

function readPositiveMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

export function createAcpTransportHandlerFromDefinition(
  definition: AcpRuntimeDefinitionV1,
): TransportHandler {
  const base = new DefaultTransport(definition.backendId);
  const baseHandler: TransportHandler = base;
  const timeouts = definition.timeouts;
  const initMs = readPositiveMs(timeouts?.initMs);
  const initDelayMs = readPositiveMs(definition.transportLifecycle?.initDelayMs) ?? readPositiveMs(timeouts?.initDelayMs);
  const idleMs = readPositiveMs(timeouts?.idleMs);
  const toolCallMs = readPositiveMs(timeouts?.toolCallMs);
  const promptLivenessMs = readPositiveMs(timeouts?.promptLivenessMs);
  const postPromptNoUpdatesMs = readPositiveMs(timeouts?.postPromptNoUpdatesMs);
  const postToolCallIdleMs = readPositiveMs(timeouts?.postToolCallIdleMs);
  const idleWithoutAssistantMessageMs = readPositiveMs(timeouts?.idleWithoutAssistantMessageMs);
  const preToolCallIdleMs = readPositiveMs(timeouts?.preToolCallIdleMs);

  const handler: TransportHandler = {
    agentName: base.agentName,
    getInitTimeout: () => initMs ?? base.getInitTimeout(),
    ...(initDelayMs !== undefined ? { getInitDelayMs: () => initDelayMs } : {}),
    filterStdoutLine: (line) => base.filterStdoutLine?.(line) ?? line,
    handleStderr: (text, context) => base.handleStderr?.(text, context) ?? { message: null },
    getToolPatterns: () => base.getToolPatterns(),
    isInvestigationTool: (toolCallId, toolKind) => base.isInvestigationTool?.(toolCallId, toolKind) ?? false,
    ...(toolCallMs !== undefined ? { getToolCallTimeout: () => toolCallMs } : {
      getToolCallTimeout: (toolCallId: string, toolKind?: string) => base.getToolCallTimeout(toolCallId, toolKind),
    }),
    extractToolNameFromId: (toolCallId) => base.extractToolNameFromId?.(toolCallId) ?? null,
    determineToolName: (toolName, toolCallId, input, context) => base.determineToolName?.(toolName, toolCallId, input, context) ?? toolName,
    ...(idleMs !== undefined ? { getIdleTimeout: () => idleMs } : {}),
    ...(preToolCallIdleMs !== undefined ? { getPreToolCallIdleTimeoutMs: () => preToolCallIdleMs } : {
      getPreToolCallIdleTimeoutMs: () => base.getPreToolCallIdleTimeoutMs(),
    }),
    ...(postPromptNoUpdatesMs !== undefined ? { getPostPromptNoUpdatesTimeoutMs: () => postPromptNoUpdatesMs } : {}),
    ...(promptLivenessMs !== undefined ? { getPromptLivenessTimeoutMs: () => promptLivenessMs } : {}),
    ...(postToolCallIdleMs !== undefined ? { getPostToolCallIdleTimeoutMs: () => postToolCallIdleMs } : {}),
    ...(idleWithoutAssistantMessageMs !== undefined ? { getIdleWithoutAssistantMessageTimeoutMs: () => idleWithoutAssistantMessageMs } : {}),
    pickPermissionOptionId: (options, decision, context) => baseHandler.pickPermissionOptionId?.(options, decision, context),
  };
  return Object.freeze(handler);
}
