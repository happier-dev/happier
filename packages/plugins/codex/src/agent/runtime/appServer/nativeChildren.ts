import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { CodexAppServerEventInput } from './core.js';
import { readExactCodexProviderSessionId } from '../../../protocol/runtimeDescriptorV1.js';
import { createCodexAppServerAssistantReasoningProjector } from './projection/assistantReasoning.js';
import { projectCodexAppServerToolEventsFromNotification } from './projection/toolEvents.js';
import { readRecord, readProviderEventItemRecord, readProviderEventTurnId, readThreadId, readTurnId, readCodexTerminalOutcome } from './wire/fields.js';

export type NativeChildProjectionContext = Readonly<{
  sidechainId: string;
  streamScopeId: string;
  projector: ReturnType<typeof createCodexAppServerAssistantReasoningProjector>;
}>;

/** Translate provider-proven child execution into host custody and isolated transcript output. */
export function createCodexNativeChildObserver(params: Readonly<{
  parentThreadId(): string | null;
  subagents?: AgentSessionRuntimeContext['session']['services']['subagents'];
  logger: Readonly<{ warn(message: string, fields?: Readonly<Record<string, unknown>>): void }>;
  publish(event: CodexAppServerEventInput): void;
  observeReasoning(method: string, notificationParams: unknown, context: NativeChildProjectionContext): boolean;
  readFailureMessage(notificationParams: unknown): string;
}>) {
  // Provider lineage admits a child. Foreign threads observed on a shared server do not.
  const nativeChildParents = new Map<string, string>();
  type NativeChildTurn = {
    threadId: string;
    turnId: string;
    parentThreadId: string;
    terminal: boolean;
    projector: ReturnType<typeof createCodexAppServerAssistantReasoningProjector>;
  };
  const nativeChildTurns = new Map<string, NativeChildTurn>();
  const childTurnKey = (childThreadId: string, childTurnId: string): string => JSON.stringify([childThreadId, childTurnId]);
  const publishNativeChildStatus = async (child: NativeChildTurn, status: 'running' | 'completed' | 'failed' | 'aborted', error?: string): Promise<void> => {
    const toolCallId = childTurnKey(child.threadId, child.turnId);
    const transcript = { sidechainId: child.threadId, threadId: child.threadId, providerTurnId: child.turnId };
    if (status === 'running') {
      params.publish({ kind: 'tool-call', toolCallId, toolName: 'SubAgent',
        toolInput: { ...transcript, parentThreadId: child.parentThreadId },
      });
    } else {
      params.publish({ kind: 'tool-result', toolCallId,
        output: { ...transcript, status: status === 'aborted' ? 'interrupted' : status, ...(error ? { error } : {}) },
        ...(status === 'failed' ? { isError: true } : {}),
      });
    }
    if (!params.subagents) return;
    try {
      await params.subagents.observe({
        observationId: childTurnKey(child.threadId, child.turnId),
        groupId: child.threadId,
        status,
        detail: {
          origin: 'agent', kind: 'native', agentRef: { agentId: 'codex' },
          vendorRef: { agentSessionId: child.threadId, vendorSource: 'codex' },
          transcript: { sidechainId: child.threadId },
          agentMetadata: { parentProviderSessionId: child.parentThreadId, providerTurnId: child.turnId },
          ...(error ? { error } : {}),
        },
      });
    } catch (error) {
      params.logger.warn('Codex native child lifecycle publication failed', {
        threadId: child.threadId, turnId: child.turnId, status,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  };
  const registerProvenance = (notificationParams: unknown): void => {
    const nativeThread = readRecord(readRecord(notificationParams)?.thread);
    const childThreadId = readExactCodexProviderSessionId(nativeThread?.id);
    const source = readRecord(readRecord(nativeThread?.source)?.subAgent);
    const spawn = readRecord(source?.thread_spawn);
    const parentThreadId = readExactCodexProviderSessionId(nativeThread?.parentThreadId)
      ?? readExactCodexProviderSessionId(spawn?.parent_thread_id);
    if (!childThreadId || !parentThreadId || childThreadId === parentThreadId) return;
    if (parentThreadId !== params.parentThreadId() && !nativeChildParents.has(parentThreadId)) return;
    nativeChildParents.set(childThreadId, parentThreadId);
  };
  const observe = (method: string, notificationParams: unknown): Promise<void> | null => {
    const item = readProviderEventItemRecord(notificationParams);
    if (item?.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
      const sender = readExactCodexProviderSessionId(item.senderThreadId);
      if (sender && (sender === params.parentThreadId() || nativeChildParents.has(sender)) && Array.isArray(item.receiverThreadIds)) {
        for (const receiver of item.receiverThreadIds) {
          const childId = readExactCodexProviderSessionId(receiver);
          if (childId && childId !== sender) nativeChildParents.set(childId, sender);
        }
      }
    }
    const childThreadId = readThreadId(notificationParams);
    const parentThreadId = childThreadId ? nativeChildParents.get(childThreadId) : null;
    if (!childThreadId || !parentThreadId) return null;
    return observeOwnedChild(method, notificationParams, childThreadId, parentThreadId);
  };
  const observeOwnedChild = async (method: string, notificationParams: unknown, childThreadId: string, parentThreadId: string): Promise<void> => {
    const childTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true }) ?? readTurnId(notificationParams);
    if (!childTurnId) return;
    const key = childTurnKey(childThreadId, childTurnId);
    let child = nativeChildTurns.get(key);
    if (!child) {
      const textByStream = new Map<string, { text: string; thinking: boolean }>();
      const messageIdForStream = (streamKey: string): string => `codex:${streamKey}`;
      const writeText = (text: string, streamKey: string, thinking: boolean, append: boolean): void => {
        textByStream.set(streamKey, { text: append ? `${textByStream.get(streamKey)?.text ?? ''}${text}` : text, thinking });
        if (append) params.publish({ kind: 'message-delta', sidechainId: childThreadId, messageId: messageIdForStream(streamKey), delta: { text, thinking } });
      };
      const projector = createCodexAppServerAssistantReasoningProjector({ bridge: {
        appendAssistantDelta: ({ deltaText, streamKey }) => writeText(deltaText, streamKey, false, true),
        appendThinkingDelta: ({ deltaText, streamKey }) => writeText(deltaText, streamKey, true, true),
        overrideAssistantText: ({ text, streamKey }) => writeText(text, streamKey, false, false),
        overrideThinkingText: ({ text, streamKey }) => writeText(text, streamKey, true, false),
        flushAll: async () => {
          for (const [streamKey, segment] of textByStream) {
            if (!segment.text.trim()) continue;
            params.publish({ kind: 'transcript-agent-message-committed', agentId: 'codex',
              localId: messageIdForStream(streamKey), sidechainId: childThreadId,
              body: { type: segment.thinking ? 'reasoning' : 'message', message: segment.text },
              meta: { source: 'codex-app-server-runtime' },
            });
          }
          textByStream.clear();
        },
      } });
      child = { threadId: childThreadId, parentThreadId, turnId: childTurnId, terminal: false, projector };
      nativeChildTurns.set(key, child);
      await publishNativeChildStatus(child, 'running');
    }
    if (child.terminal) return;
    if (method === 'turn/completed' || method === 'turn/interrupted') {
      const outcome = readCodexTerminalOutcome(method, notificationParams);
      child.terminal = true;
      await child.projector.flush(outcome === 'completed' ? 'turn-end' : 'abort');
      await publishNativeChildStatus(child, outcome === 'interrupted' ? 'aborted' : outcome,
        outcome === 'failed' ? params.readFailureMessage(notificationParams) : undefined);
      return;
    }
    params.observeReasoning(method, notificationParams, { sidechainId: childThreadId, streamScopeId: key, projector: child.projector });
    if (method === 'rawResponseItem/completed') return;
    for (const event of projectCodexAppServerToolEventsFromNotification({ method, notificationParams })) {
      if (event.type === 'tool-call') params.publish({ kind: 'tool-call', sidechainId: childThreadId, toolCallId: event.callId, toolName: event.name, toolInput: event.input });
      else params.publish({ kind: 'tool-result', sidechainId: childThreadId, toolCallId: event.callId, output: event.output, ...(event.isError === undefined ? {} : { isError: event.isError }) });
    }
    return;
  };

  return { registerProvenance, observe };
}
