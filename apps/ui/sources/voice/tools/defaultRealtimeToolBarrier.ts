import type {
  VoiceConversationToolEffectCalls} from '@happier-dev/protocol/plugins/contributions/voice';
import type {
  VoiceRealtimeToolResultV1,
} from '@happier-dev/protocol/voice/realtime/events';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { storage } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import {
  redactVoiceToolResultForProvider,
  redactVoiceActionExecutionResultForProvider,
  type VoiceToolResultRedactionPrefs,
} from '@/voice/context/redactVoiceToolResult';
import {
  createVoiceToolHandlers,
  resolveVoiceToolEffectClass,
  type VoiceToolHandler,
} from '@/voice/tools/handlers';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import { VoiceAssistantActionSchema } from '@happier-dev/protocol/voice/actions';
import { listVoiceToolActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveVoiceActionExecution, resolveVoiceExecutionToolName, VOICE_ACTION_EXECUTE_TOOL_NAME } from './voiceActionExecution';
import { isCurrentUiContextVoiceAction } from './resolveDisabledVoiceActionIds';
import type { VoiceHostTextPlayback } from '@happier-dev/plugin-sdk/voice/client';
import {
  createRealtimeToolBarrier,
  RealtimeToolExecutionError,
} from './realtimeToolBarrier';

type VoiceToolHandlers = Readonly<Record<string, VoiceToolHandler>>;

type VoiceHandlerBarrierDeps = Readonly<{
  handlers: VoiceToolHandlers;
  exposure?: 'voice_assistant' | 'current_ui_only';
  /** Omission is intentionally fail-closed for internal and legacy callers. */
  effectCalls?: VoiceConversationToolEffectCalls;
  readRedactionPrefs: () => VoiceToolResultRedactionPrefs;
  submitResults: (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    signal: AbortSignal,
  ) => Promise<void>;
  continueResponse: (responseId: string, signal: AbortSignal) => Promise<void>;
}>;

type DefaultRealtimeToolBarrierDeps = Readonly<{
  voiceSessionBinding?: VoiceSessionBinding | null;
  playHostText?: VoiceHostTextPlayback;
  resolveSessionId: (explicitSessionId?: string | null) => string | null;
  /** Home captured with the connected Voice attempt; survives later navigation. */
  currentServerId?: string | null;
  /** Machine captured from this attempt's existing Start admission. */
  currentExecutionTarget?: SessionExecutionTargetV1 | null;
  exposure?: 'voice_assistant' | 'current_ui_only';
  currentSessionAddress?: SessionAddress | null;
  /** Provider-local current-context capability; absent means no such tool. */
  currentUiContext?: VoiceCurrentUiToolPort;
  /** Omission is intentionally fail-closed for internal and legacy callers. */
  effectCalls?: VoiceConversationToolEffectCalls;
  submitResults: (
    responseId: string,
    results: readonly VoiceRealtimeToolResultV1[],
    signal: AbortSignal,
  ) => Promise<void>;
  continueResponse: (responseId: string, signal: AbortSignal) => Promise<void>;
}>;

function parseHandlerResult(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
}

function readHandlerFailure(value: unknown): PluginError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.ok !== false) return null;
  const code = typeof record.errorCode === 'string' && record.errorCode.length > 0 ? record.errorCode : 'tool_failed';
  return new PluginError({ code,
    ...(record.details === undefined ? {} : { details: StrictJsonValueSchema.parse(record.details) }),
  });
}

export function createRealtimeToolBarrierForVoiceHandlers(deps: VoiceHandlerBarrierDeps) {
  return createRealtimeToolBarrier({
    validateCall: (call) => {
      const rejected = { status: 'rejected' as const, code: 'invalid_tool_call' };
      if (deps.exposure === 'current_ui_only') {
        const spec = listVoiceToolActionSpecs().find((candidate) => candidate.bindings?.voiceClientToolName === call.toolName);
        if (!spec || !isCurrentUiContextVoiceAction(spec.id)) return rejected;
      }
      const valid = call.toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
        ? resolveVoiceActionExecution(call.arguments) !== null
        : VoiceAssistantActionSchema.safeParse({ t: call.toolName, args: call.arguments }).success;
      return valid ? { status: 'allowed' } : rejected;
    },
    classifyCall: (call) => resolveVoiceToolEffectClass(call.toolName, call.arguments),
    authorizeCall: async (call) => {
      if (
        deps.effectCalls !== 'stable_ids'
        && resolveVoiceToolEffectClass(call.toolName, call.arguments) !== 'read_only'
      ) {
        return { status: 'denied', code: 'voice_effect_call_custody_unavailable' };
      }
      return { status: 'allowed' };
    },
    executeCall: async (call, signal) => {
      const handler = deps.handlers[call.toolName];
      if (!handler) throw new RealtimeToolExecutionError('error', 'unsupported_action');
      const parsed = parseHandlerResult(await handler(call.arguments, {
        callId: call.callId,
        signal,
      }));
      const failure = readHandlerFailure(parsed);
      if (failure) throw failure;
      return parsed;
    },
    redactResult: (value, call) => (call.toolName === VOICE_ACTION_EXECUTE_TOOL_NAME
      ? redactVoiceActionExecutionResultForProvider : redactVoiceToolResultForProvider)(
      resolveVoiceExecutionToolName(call.toolName, call.arguments), value, deps.readRedactionPrefs(),
    ),
    submitResults: deps.submitResults,
    continueResponse: deps.continueResponse,
  });
}

export function createDefaultRealtimeToolBarrier(deps: DefaultRealtimeToolBarrierDeps) {
  return createRealtimeToolBarrierForVoiceHandlers({
    handlers: createVoiceToolHandlers({
      voiceSessionBinding: deps.voiceSessionBinding,
      resolveSessionId: deps.resolveSessionId,
      currentSessionAddress: deps.currentSessionAddress,
      currentServerId: deps.currentServerId,
      currentExecutionTarget: deps.currentExecutionTarget,
      // Realtime lacks Local's host tool-result speaker. Missing capability
      // therefore means ordinary Ask, never an unfinishable read-back binding.
      playHostText: deps.playHostText ?? (async () => ({ status: 'unavailable', code: 'host_text_playback_unavailable' })),
      ...(deps.currentUiContext ? { currentUiContext: deps.currentUiContext } : {}),
    }),
    effectCalls: deps.effectCalls,
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
