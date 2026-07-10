import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import type { OpenCodeToolPart } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import { isTerminalOpenCodeToolPartStatus } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import { readOpenCodeToolCallKey, type OpenCodeServerRuntimeState } from './state.js';

function buildOpenCodeToolResultOutput(part: OpenCodeToolPart): unknown {
  const title = normalizeString(part.state.title);
  const metadata = asRecord(part.state.metadata);
  if (!title && !metadata) return part.state.output ?? {};

  const outputRecord = asRecord(part.state.output);
  if (outputRecord) {
    return {
      ...outputRecord,
      ...(title ? { title } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  return {
    output: part.state.output ?? '',
    ...(title ? { title } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function publishOpenCodeToolPartRuntimeEvents(params: Readonly<{
  part: OpenCodeToolPart;
  state: OpenCodeServerRuntimeState;
  happierSessionId: string;
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  nowMs?: () => number;
}>): void {
  const turnId = params.state.activeTurnId;
  if (!params.state.turnInFlight || !turnId) return;

  const callKey = readOpenCodeToolCallKey(params.part);
  const emittedAtMs = params.nowMs?.() ?? Date.now();
  const isTerminal = isTerminalOpenCodeToolPartStatus(params.part.state.status);
  const toolInput = params.part.state.input ?? {};

  if (!params.state.currentTurnPublishedToolCallKeys.has(callKey)) {
    params.state.currentTurnPublishedToolCallKeys.add(callKey);
    params.publishRuntimeEvent({
      kind: 'tool-call',
      sessionId: params.happierSessionId,
      turnId,
      toolCallId: params.part.callID,
      toolName: params.part.tool,
      toolInput,
      emittedAtMs,
    });
  }

  if (!isTerminal || params.state.currentTurnPublishedToolResultKeys.has(callKey)) return;

  params.state.currentTurnPublishedToolResultKeys.add(callKey);
  const status = params.part.state.status;
  params.publishRuntimeEvent({
    kind: 'tool-result',
    sessionId: params.happierSessionId,
    turnId,
    toolCallId: params.part.callID,
    output: buildOpenCodeToolResultOutput(params.part),
    emittedAtMs,
    ...(status === 'completed' ? {} : { isError: true }),
  });
}
