import type { PluginApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type {
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolResult,
} from '@happier-dev/plugin-sdk/voice/client';

type VoiceProviderRuntime = Parameters<PluginApi['voiceProviders']['register']>[1];

const READ_CURRENT_UI_CONTEXT = 'readCurrentUiContext';
const INVOKE_CURRENT_UI_COMMAND = 'invokeCurrentUiCommand';
const PACKED_PROVIDER_DETAIL_SCREEN = 'packed-provider-detail';
const READ_RESPONSE_ID = 'packed-current-ui-context';
const READ_CALL_ID = 'packed-current-ui-context-call';
const INVOKE_RESPONSE_ID = 'packed-current-ui-command';
const INVOKE_CALL_ID = 'packed-current-ui-command-call';
const COMPLETION_TEXT = 'Packed Voice action completed for packed-provider-detail.';
const AUTOMATIC_METADATA_COMPLETION_TEXT = 'Packed Voice automatic context metadata received.';
const CURRENT_UI_TOOL_CATALOG_PREFIX = 'Packed Voice current UI tools:';

type PackedConversationStage =
  | 'idle'
  | 'waiting_for_read'
  | 'waiting_for_invoke'
  | 'completed'
  | 'closed';

type PackedSuccessfulToolResult = Readonly<{
  responseId: string;
  callId: string;
  toolName: string;
  order: number;
  output: VoiceRealtimeJsonValue;
}>;

type PackedControlQueue = Readonly<{
  push(value: VoiceRealtimeJsonValue): void;
  close(): void;
  events(signal: AbortSignal): AsyncIterable<VoiceRealtimeJsonValue>;
}>;

async function* emptyEvents<T>(): AsyncIterable<T> {
  return;
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStableString(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    ? value
    : null;
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function createControlQueue(): PackedControlQueue {
  const values: VoiceRealtimeJsonValue[] = [];
  let closed = false;
  let resume: (() => void) | null = null;

  const wake = () => {
    const waiter = resume;
    resume = null;
    waiter?.();
  };

  return {
    push(value) {
      if (closed) return;
      values.push(value);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *events(signal) {
      while (!closed) {
        throwIfAborted(signal);
        const value = values.shift();
        if (value !== undefined) {
          yield value;
          continue;
        }
        await new Promise<void>((resolve) => {
          const settle = () => {
            signal.removeEventListener('abort', settle);
            if (resume === settle) resume = null;
            resolve();
          };
          resume = settle;
          signal.addEventListener('abort', settle, { once: true });
          if (closed || signal.aborted || values.length > 0) settle();
        });
      }
    },
  };
}

function createToolCall(input: Readonly<{
  responseId: string;
  callId: string;
  toolName: string;
  arguments: VoiceRealtimeJsonValue;
}>): VoiceRealtimeJsonValue {
  return {
    kind: 'packed_tool_call',
    responseId: input.responseId,
    callId: input.callId,
    toolName: input.toolName,
    order: 0,
    arguments: input.arguments,
  };
}

function readSuccessfulToolResults(event: VoiceRealtimeJsonValue): readonly PackedSuccessfulToolResult[] {
  if (
    !isJsonRecord(event)
    || event.kind !== 'packed_tool_results'
    || !Array.isArray(event.results)
  ) {
    return [];
  }
  const results: PackedSuccessfulToolResult[] = [];
  for (const candidate of event.results) {
    if (!isJsonRecord(candidate) || candidate.v !== 1 || candidate.status !== 'success') continue;
    const responseId = readStableString(candidate.responseId);
    const callId = readStableString(candidate.callId);
    const toolName = readStableString(candidate.toolName);
    const order = readNonnegativeInteger(candidate.order);
    if (!responseId || !callId || !toolName || order === null || !('output' in candidate)) continue;
    results.push({
      responseId,
      callId,
      toolName,
      order,
      output: candidate.output,
    });
  }
  return results;
}

function readCurrentUiCommandId(output: VoiceRealtimeJsonValue): string | null {
  if (!isJsonRecord(output) || !Array.isArray(output.commands)) return null;
  for (const candidate of output.commands) {
    if (!isJsonRecord(candidate)) continue;
    const commandId = readStableString(candidate.id);
    if (commandId) return commandId;
  }
  return null;
}

function isPackedVoiceActionSuccess(output: VoiceRealtimeJsonValue): boolean {
  return isJsonRecord(output) && output.ok === true;
}

function readPackedAutomaticContextMetadata(event: VoiceRealtimeJsonValue): string | null {
  if (!isJsonRecord(event) || event.kind !== 'packed_automatic_context_metadata') return null;
  const text = event.text;
  return typeof text === 'string' && text.length > 0 && text.length <= 4_096
    ? text
    : null;
}

function readPackedCurrentUiToolCatalog(
  event: VoiceRealtimeJsonValue,
): readonly string[] | null {
  if (!isJsonRecord(event) || event.kind !== 'packed_current_ui_tool_catalog') {
    return null;
  }
  if (!Array.isArray(event.toolNames)) return null;
  const names = event.toolNames.map(readStableString);
  if (names.some((name) => name === null)) return null;
  return names as readonly string[];
}

function encodeToolResult(result: VoiceRealtimeToolResult): VoiceRealtimeJsonValue {
  const encoded: Record<string, VoiceRealtimeJsonValue> = {
    v: result.v,
    responseId: result.responseId,
    callId: result.callId,
    toolName: result.toolName,
    order: result.order,
    status: result.status,
  };
  if (result.output !== undefined) encoded.output = result.output;
  if (result.errorCode !== undefined) encoded.errorCode = result.errorCode;
  return encoded;
}

function decodePackedControl(event: VoiceRealtimeJsonValue): readonly VoiceRealtimeCanonicalEvent[] {
  if (!isJsonRecord(event)) return [];
  if (event.kind === 'packed_tool_call') {
    const responseId = readStableString(event.responseId);
    const callId = readStableString(event.callId);
    const toolName = readStableString(event.toolName);
    const order = readNonnegativeInteger(event.order);
    if (!responseId || !callId || !toolName || order === null || !('arguments' in event)) return [];
    return [{
      type: 'tool_calls',
      responseId,
      calls: [{
        v: 1,
        responseId,
        callId,
        toolName,
        order,
        arguments: event.arguments,
      }],
    }];
  }
  if (event.kind === 'packed_voice_completion' && event.text === COMPLETION_TEXT) {
    return [{
      type: 'transcript',
      event: {
        v: 1,
        epoch: 0,
        sequence: 0,
        revision: 1,
        eventId: 'packed-current-ui-context-completion',
        itemId: 'packed-current-ui-context-completion',
        role: 'assistant',
        text: COMPLETION_TEXT,
        provenance: 'live',
        type: 'voice.transcript.final',
      },
    }];
  }
  if (
    event.kind === 'packed_automatic_context_metadata_observed'
    && typeof event.contextText === 'string'
  ) {
    return [{
      type: 'transcript',
      event: {
        v: 1,
        epoch: 0,
        sequence: 1,
        revision: 1,
        eventId: 'packed-automatic-context-metadata',
        itemId: 'packed-automatic-context-metadata',
        role: 'assistant',
        text: `${AUTOMATIC_METADATA_COMPLETION_TEXT}\n${event.contextText}`,
        provenance: 'live',
        type: 'voice.transcript.final',
      },
    }];
  }
  const toolNames = readPackedCurrentUiToolCatalog(event);
  if (toolNames !== null) {
    return [{
      type: 'transcript',
      event: {
        v: 1,
        epoch: 0,
        sequence: 2,
        revision: 1,
        eventId: 'packed-current-ui-tool-catalog',
        itemId: 'packed-current-ui-tool-catalog',
        role: 'assistant',
        text: `${CURRENT_UI_TOOL_CATALOG_PREFIX} ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}.`,
        provenance: 'live',
        type: 'voice.transcript.final',
      },
    }];
  }
  return [];
}

function readDelayMs(input: unknown): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 0;
  const delayMs = 'delayMs' in input ? input.delayMs : undefined;
  return typeof delayMs === 'number' && Number.isFinite(delayMs)
    ? Math.min(Math.max(Math.floor(delayMs), 0), 60_000)
    : 0;
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error('packed_targeted_fixture_action_cancelled');
  }
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('packed_targeted_fixture_action_cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const inspectCurrentContext: PluginClientActionHandler = async (input, context) => {
  await waitForDelay(readDelayMs(input), context.signal);
  return {
    screen: context.currentUiContext?.navigation.screen ?? 'unavailable',
    invocationSurface: context.invocationSurface,
  };
};

const applyLocalEffect: PluginClientActionHandler = async (_input, context) => {
  await context.ui.openSurface(
    'packed-provider-page',
    undefined,
    { subPath: 'local-effect', signal: context.signal },
  );
  return {
    screen: PACKED_PROVIDER_DETAIL_SCREEN,
    invocationSurface: context.invocationSurface,
  };
};

let activePackedInputCapture: Readonly<{
  setMuted(muted: boolean): void;
}> | null = null;

const packedConversationRuntime = {
  kind: 'conversation',
  microphoneMode: 'provider_managed',
  protocol: {
    async prepare({ signal }) {
      throwIfAborted(signal);
      return {
        kind: 'prepared',
        session: { config: {}, safeMetadata: {} },
      } as const;
    },
    decodeControl: decodePackedControl,
    encodeTurnControl: () => null,
  },
  async createConnection({ signal, tools }) {
    throwIfAborted(signal);
    const queue = createControlQueue();
    const advertisedCurrentUiToolNames = [
      READ_CURRENT_UI_CONTEXT,
      INVOKE_CURRENT_UI_COMMAND,
    ].filter((toolName) => tools.some((tool) => tool.name === toolName));
    const supportsCurrentUiCommand = advertisedCurrentUiToolNames.length === 2;
    let state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
    let stage: PackedConversationStage = 'idle';
    let automaticMetadataObserved = false;
    let inputCaptureMuted = false;
    const inputCapture = Object.freeze({
      setMuted(muted: boolean) {
        // This fixture's provider-owned capture handle keeps its own input
        // state, matching the public provider-managed mute contract.
        inputCaptureMuted = muted;
      },
      isMuted() {
        return inputCaptureMuted;
      },
    });
    activePackedInputCapture = inputCapture;
    return {
      kind: 'sdk_handle',
      async connect(connectionSignal: AbortSignal) {
        throwIfAborted(connectionSignal);
        if (state !== 'idle') return;
        state = 'connecting';
        throwIfAborted(signal);
        state = 'open';
        queue.push({
          kind: 'packed_current_ui_tool_catalog',
          toolNames: advertisedCurrentUiToolNames,
        });
        if (!supportsCurrentUiCommand) {
          stage = 'completed';
          return;
        }
        stage = 'waiting_for_read';
        queue.push(createToolCall({
          responseId: READ_RESPONSE_ID,
          callId: READ_CALL_ID,
          toolName: READ_CURRENT_UI_CONTEXT,
          arguments: {},
        }));
      },
      async sendControl(event: VoiceRealtimeJsonValue) {
        if (state !== 'open') return;
        const automaticContextText = readPackedAutomaticContextMetadata(event);
        if (automaticContextText !== null) {
          if (automaticMetadataObserved) return;
          automaticMetadataObserved = true;
          queue.push({
            kind: 'packed_automatic_context_metadata_observed',
            contextText: automaticContextText,
          });
          return;
        }
        const results = readSuccessfulToolResults(event);
        if (stage === 'waiting_for_read') {
          const readResult = results.find((result) => (
            result.responseId === READ_RESPONSE_ID
            && result.callId === READ_CALL_ID
            && result.toolName === READ_CURRENT_UI_CONTEXT
            && result.order === 0
          ));
          if (!readResult) return;
          const commandId = readCurrentUiCommandId(readResult.output);
          if (!commandId) {
            stage = 'completed';
            return;
          }
          stage = 'waiting_for_invoke';
          queue.push(createToolCall({
            responseId: INVOKE_RESPONSE_ID,
            callId: INVOKE_CALL_ID,
            toolName: INVOKE_CURRENT_UI_COMMAND,
            arguments: { commandId },
          }));
          return;
        }
        if (stage !== 'waiting_for_invoke') return;
        const invokeResult = results.find((result) => (
          result.responseId === INVOKE_RESPONSE_ID
          && result.callId === INVOKE_CALL_ID
          && result.toolName === INVOKE_CURRENT_UI_COMMAND
          && result.order === 0
        ));
        if (!invokeResult) return;
        stage = 'completed';
        if (isPackedVoiceActionSuccess(invokeResult.output)) {
          queue.push({
            kind: 'packed_voice_completion',
            text: COMPLETION_TEXT,
          });
        }
      },
      controlEvents: queue.events,
      transportEvents: emptyEvents,
      async close() {
        state = 'closed';
        stage = 'closed';
        if (activePackedInputCapture === inputCapture) activePackedInputCapture = null;
        queue.close();
      },
      state: () => state,
      currentProviderSessionId: () => null,
      playbackCursorMs: () => null,
      beginOutputInterruptionCandidate: () => 'unsupported' as const,
      resolveOutputInterruptionCandidate() {},
    } as const;
  },
  encodeToolResults(results) {
    return [{
      kind: 'packed_tool_results',
      results: results.map(encodeToolResult),
    }];
  },
  encodeToolContinuation: () => ({ kind: 'packed_tool_continuation' }),
  encodeContextUpdate: (text) => [{ kind: 'packed_automatic_context_metadata', text }],
  encodeTextTurn: () => [],
  outputLevelMeter: 'unavailable',
  setInputMuted(muted) {
    const inputCapture = activePackedInputCapture;
    if (!inputCapture) throw new Error('packed_provider_input_capture_unavailable');
    inputCapture.setMuted(muted);
  },
} satisfies VoiceProviderRuntime;

export function activate(api: PluginClientApi): void {
  api.actions.register('inspect-context', inspectCurrentContext);
  api.actions.register('inspect-web-only', inspectCurrentContext);
  api.actions.register('apply-local-effect', applyLocalEffect);
  api.voiceProviders.register('packed-conversation', packedConversationRuntime);
}
