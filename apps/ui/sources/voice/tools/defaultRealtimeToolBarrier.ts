import type {
  VoiceRealtimeToolResultV1,
} from '@happier-dev/protocol/voice/realtime/events';

import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { storage } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import {
  redactVoiceToolResultForProvider,
  redactVoiceActionExecutionResultForProvider,
  redactVoiceToolResultValue,
  type VoiceToolResultRedactionPrefs,
} from '@/voice/context/redactVoiceToolResult';
import {
  createVoiceToolHandlers,
  resolveVoiceToolEffectClass,
  type VoiceToolHandler,
} from '@/voice/tools/handlers';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { decodeVoiceToolInput, resolveVoiceExecutionToolName, VOICE_ACTION_EXECUTE_TOOL_NAME } from './voiceActionExecution';
import { resolveVoiceToolResultHumanSummary } from '@/voice/context/resolveVoiceToolResultHumanSummary';
import { isCurrentUiContextVoiceAction } from './resolveDisabledVoiceActionIds';
import type { VoiceHostTextPlayback } from '@happier-dev/plugin-sdk/voice/client';
import type { SpokenActionTurnOrigin } from './executeSpokenAction';
import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import {
  createRealtimeToolBarrier,
  RealtimeToolExecutionError,
} from './realtimeToolBarrier';

type VoiceToolHandlers = Readonly<Record<string, VoiceToolHandler>>;

type VoiceHandlerBarrierDeps = Readonly<{
  handlers: VoiceToolHandlers;
  exposure?: 'voice_assistant' | 'current_ui_only';
  readRedactionPrefs: () => VoiceToolResultRedactionPrefs;
  submitResults: (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    signal: AbortSignal,
  ) => Promise<void>;
  continueResponse: (responseId: string, signal: AbortSignal, turnOrigin: SpokenActionTurnOrigin) => Promise<void>;
}>;

type DefaultRealtimeToolBarrierDeps = Readonly<{
  onSetupRequired?: (error: VoiceMachineError) => void;
  voiceSessionBinding?: VoiceSessionBinding | null;
  playHostText?: VoiceHostTextPlayback;
  resolveSessionId: (explicitSessionId?: string | null) => string | null;
  /** Home captured with the connected Voice attempt; survives later navigation. */
  currentServerId?: string | null;
  /** Machine captured from this attempt's existing Start admission. */
  currentExecutionTarget?: SessionExecutionTargetV1 | null;
  exposure?: 'voice_assistant' | 'current_ui_only';
  resolveCurrentSessionAddress?: () => Promise<SessionAddress | null>;
  /** Provider-local current-context capability; absent means no such tool. */
  currentUiContext?: VoiceCurrentUiToolPort;
  submitResults: (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    signal: AbortSignal,
  ) => Promise<void>;
  continueResponse: (responseId: string, signal: AbortSignal, turnOrigin: SpokenActionTurnOrigin) => Promise<void>;
}>;

function parseHandlerResult(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
}

export function createRealtimeToolBarrierForVoiceHandlers(deps: VoiceHandlerBarrierDeps) {
  return createRealtimeToolBarrier({
    validateCall: (call) => {
      const rejected = { status: 'rejected' as const, code: 'invalid_tool_call' };
      if (deps.exposure === 'current_ui_only') {
        const spec = listVoiceToolActionSpecs().find((candidate) => candidate.bindings?.voiceClientToolName === call.toolName);
        if (!spec || !isCurrentUiContextVoiceAction(spec.id)) return rejected;
      }
      const input = decodeVoiceToolInput(call.toolName, call.arguments);
      return input.ok ? { status: 'allowed', call: { ...call, toolName: input.toolName, arguments: input.arguments } }
        : { ...rejected, failure: input };
    },
    classifyCall: (call) => resolveVoiceToolEffectClass(call.toolName, call.arguments),
    executeCall: async (call, signal, turnOrigin) => {
      const handler = deps.handlers[call.toolName];
      if (!handler) throw new RealtimeToolExecutionError('error', 'unsupported_action');
      return parseHandlerResult(await handler(call.arguments, {
        callId: call.callId,
        signal,
        turnOrigin,
      }));
    },
    redactResult: (value, call) => (call.toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
      ? redactVoiceActionExecutionResultForProvider : redactVoiceToolResultForProvider)(
      resolveVoiceExecutionToolName(call.toolName, call.arguments), value, deps.readRedactionPrefs(),
    ),
    summarizeResult: (value, call) => {
      const prefs = deps.readRedactionPrefs();
      return resolveVoiceToolResultHumanSummary({ toolName: call.toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
        ? call.toolName : resolveVoiceExecutionToolName(call.toolName, call.arguments),
        toolInput: redactVoiceToolResultValue(call.arguments, prefs), toolResult: value,
        shareFilePaths: prefs.shareFilePaths, shareSessionSummary: prefs.shareSessionSummary });
    },
    submitResults: deps.submitResults,
    continueResponse: deps.continueResponse,
  });
}

export function createDefaultRealtimeToolBarrier(deps: DefaultRealtimeToolBarrierDeps) {
  return createRealtimeToolBarrierForVoiceHandlers({
    handlers: createVoiceToolHandlers({
      voiceSessionBinding: deps.voiceSessionBinding,
      resolveSessionId: deps.resolveSessionId,
      resolveCurrentSessionAddress: deps.resolveCurrentSessionAddress,
      currentServerId: deps.currentServerId,
      currentExecutionTarget: deps.currentExecutionTarget,
      onSetupRequired: deps.onSetupRequired,
      // Realtime lacks Local's host tool-result speaker. Missing capability
      // therefore means ordinary Ask, never an unfinishable read-back binding.
      playHostText: deps.playHostText ?? (async () => ({ status: 'unavailable', code: 'host_text_playback_unavailable' })),
      ...(deps.currentUiContext ? { currentUiContext: deps.currentUiContext } : {}),
    }),
    exposure: deps.exposure,
    readRedactionPrefs: () => {
      const settings = (storage.getState() as { settings?: unknown }).settings;
      const privacy = readVoicePrivacySettings(settings);
      return {
        shareFilePaths: privacy.shareFilePaths,
        shareSessionSummary: privacy.shareSessionSummary,
        sharePermissionRequests: privacy.sharePermissionRequests,
        shareDeviceInventory: privacy.shareDeviceInventory,
        shareRecentMessages: privacy.shareRecentMessages,
      };
    },
    submitResults: deps.submitResults,
    continueResponse: deps.continueResponse,
  });
}
