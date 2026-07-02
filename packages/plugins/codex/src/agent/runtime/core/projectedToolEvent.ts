import { randomUUID } from 'node:crypto';

import type { CodexProjectedRolloutEvent } from '../../rollout/projection/messages.js';

type CodexProjectedToolEvent = Extract<
  CodexProjectedRolloutEvent,
  { type: 'tool-call' } | { type: 'tool-result' }
>;

type CodexProjectedToolCallMessage = Readonly<{
  type: 'tool-call';
  callId: string;
  name: string;
  input: unknown;
  id: string;
  sidechainId?: string;
}>;

type CodexProjectedToolResultMessage = Readonly<{
  type: 'tool-result';
  callId: string;
  output: unknown;
  id: string;
  isError?: boolean;
  sidechainId?: string;
}>;

type CodexProjectedCodexToolResultMessage = Readonly<{
  type: 'tool-call-result';
  callId: string;
  output: unknown;
  id: string;
  isError?: boolean;
}>;

type CodexProjectedToolEventSession = Readonly<{
  sendAgentMessage: (
    agentId: 'codex',
    body: CodexProjectedToolCallMessage | CodexProjectedToolResultMessage,
  ) => void | Promise<void>;
  sendCodexMessage: (
    body: CodexProjectedToolCallMessage | CodexProjectedCodexToolResultMessage,
  ) => void | Promise<void>;
}>;

export async function sendCodexProjectedToolEvent(params: Readonly<{
  session: CodexProjectedToolEventSession;
  event: CodexProjectedToolEvent;
  flushBeforeToolCall?: (() => Promise<void>) | null;
  flushBeforeToolResult?: (() => Promise<void>) | null;
}>): Promise<void> {
  if (params.event.type === 'tool-call') {
    await params.flushBeforeToolCall?.();
    if (params.event.sidechainId) {
      await params.session.sendAgentMessage('codex', {
        type: 'tool-call',
        callId: params.event.callId,
        name: params.event.name,
        input: params.event.input,
        id: randomUUID(),
        sidechainId: params.event.sidechainId,
      });
      return;
    }

    await params.session.sendCodexMessage({
      type: 'tool-call',
      callId: params.event.callId,
      name: params.event.name,
      input: params.event.input,
      id: randomUUID(),
    });
    return;
  }

  await params.flushBeforeToolResult?.();
  if (params.event.sidechainId) {
    await params.session.sendAgentMessage('codex', {
      type: 'tool-result',
      callId: params.event.callId,
      output: params.event.output,
      id: randomUUID(),
      sidechainId: params.event.sidechainId,
      ...(params.event.isError ? { isError: params.event.isError } : {}),
    });
    return;
  }

  await params.session.sendCodexMessage({
    type: 'tool-call-result',
    callId: params.event.callId,
    output: params.event.output,
    id: randomUUID(),
    ...(params.event.isError ? { isError: params.event.isError } : {}),
  });
}
