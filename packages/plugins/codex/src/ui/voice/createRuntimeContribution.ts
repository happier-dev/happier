import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  PluginVoiceProviderProtocol,
  PluginVoiceProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk/runtime';
import type {
  AgentSessionRealtimeStartResult,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import {
  createCodexV3ControlDecoder,
  type CodexV3ControlDecoder,
} from './codexV3ControlCodec.js';

const PROVIDER_ID = 'realtime_codex';
const CONTROL_CHANNEL_LABEL = 'oai-events';
const EMPTY_CONTROLS = Object.freeze([]) as readonly VoiceRealtimeJsonValue[];
const START_REMEDIATION_BY_DIAGNOSTIC_CODE = Object.freeze({
  codex_realtime_authentication_required: 'authentication_required',
  codex_realtime_agent_session_disposed: 'session_unavailable',
  codex_realtime_session_disposed: 'session_unavailable',
  codex_realtime_runtime_exited: 'session_unavailable',
  codex_realtime_runtime_restart_required: 'session_unavailable',
  codex_realtime_retry_unavailable: 'session_unavailable',
  codex_realtime_thread_unavailable: 'session_unavailable',
  codex_realtime_thread_changed: 'session_unavailable',
  codex_realtime_runtime_unavailable: 'unsupported_runtime',
  codex_realtime_runtime_version_unsupported: 'update_required',
  codex_realtime_version_unsupported: 'update_required',
  codex_realtime_feature_not_advertised: 'update_required',
  codex_realtime_feature_missing: 'update_required',
  codex_realtime_inspect_aborted: 'feature_unavailable',
  codex_realtime_feature_list_unavailable: 'feature_unavailable',
  codex_realtime_feature_list_invalid: 'feature_unavailable',
  codex_realtime_feature_state_invalid: 'feature_unavailable',
  codex_realtime_feature_state_ambiguous: 'feature_unavailable',
  codex_realtime_feature_pagination_invalid: 'feature_unavailable',
  codex_realtime_feature_pagination_incomplete: 'feature_unavailable',
  codex_realtime_feature_disabled: 'feature_unavailable',
} as const);

function agentRealtimeError(code: string, message: string): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(message), { code });
}

function startFailureCode(
  result: Exclude<AgentSessionRealtimeStartResult, Readonly<{ status: 'started' }>>,
): string {
  if ('diagnostic' in result && result.diagnostic) {
    const diagnosticCode = result.diagnostic.code;
    return START_REMEDIATION_BY_DIAGNOSTIC_CODE[
      diagnosticCode as keyof typeof START_REMEDIATION_BY_DIAGNOSTIC_CODE
    ] ?? diagnosticCode;
  }
  return `voice_agent_realtime_${result.status}`;
}

export function createCodexRealtimeVoiceProviderRuntimeRegistration():
  PluginVoiceProviderRuntimeRegistration {
  const activeAttemptsById = new Map<number, Readonly<{
    attemptId: number;
    decoder: CodexV3ControlDecoder;
  }>>();
  let currentAttemptId: number | null = null;

  const protocol: PluginVoiceProviderProtocol = Object.freeze({
    async preflight({ platform, signal }) {
      if (platform !== 'web') {
        return { kind: 'declined', code: 'voice_agent_realtime_unsupported_platform' };
      }
      return signal.aborted ? { kind: 'aborted' } : { kind: 'ready' };
    },
    async prepare({ platform, signal }) {
      if (platform !== 'web') {
        return { kind: 'declined', code: 'voice_agent_realtime_unsupported_platform' };
      }
      if (signal.aborted) return { kind: 'aborted' };
      return {
        kind: 'prepared',
        session: {
          config: {},
          safeMetadata: { providerId: PROVIDER_ID },
        },
      };
    },
    decodeControl(event) {
      return currentAttemptId === null
        ? Object.freeze([])
        : activeAttemptsById.get(currentAttemptId)?.decoder(event) ?? Object.freeze([]);
    },
    encodeTurnControl: () => null,
    releasePrepared({ attemptId }) {
      const attempt = activeAttemptsById.get(attemptId);
      if (!attempt) return;
      activeAttemptsById.delete(attemptId);
      if (currentAttemptId === attemptId) currentAttemptId = null;
      attempt.decoder.finalize();
    },
  });
  const registration: PluginVoiceProviderRuntimeRegistration = {
    protocol,
    outputLevelMeter: 'unavailable',
    requiresMicForConnection: true,
    async createConnection({ attemptId, media, signal, execution, ui }) {
      if (execution.kind !== 'experimental_agent_session_realtime') {
        throw new Error('voice_agent_realtime_execution_authority_required');
      }
      const availability = await execution.agentSessionRealtime.inspect({ signal });
      if (availability.status !== 'available') {
        throw agentRealtimeError(
          availability.reason,
          `voice_agent_realtime_${availability.reason}:${availability.diagnostic.code}`,
        );
      }
      const decoder = activeAttemptsById.get(attemptId)?.decoder ?? createCodexV3ControlDecoder({
        attemptId,
        diagnostic(code) {
          ui.diagnostic({ code, severity: 'warning' });
        },
      });
      activeAttemptsById.set(attemptId, Object.freeze({ attemptId, decoder }));
      currentAttemptId = attemptId;
      return media.createWebRtcConnection({
        signaling: {
          async exchangeOffer({ offerSdp, signal: offerSignal }) {
            const result = await execution.agentSessionRealtime.start(
              { transport: { kind: 'webrtc', offerSdp } },
              { signal: offerSignal },
            );
            if (result.status !== 'started') {
              const code = startFailureCode(result);
              const diagnostic = 'diagnostic' in result ? result.diagnostic : undefined;
              throw agentRealtimeError(
                code,
                `voice_agent_realtime_${result.status}${
                  diagnostic ? `:${diagnostic.code}` : ''
                }`,
              );
            }
            decoder.markStarted();
            return { answerSdp: result.transport.answerSdp };
          },
        },
        control: {
          label: CONTROL_CHANNEL_LABEL,
          onOpen() {},
        },
      });
    },
    encodeToolResults: () => EMPTY_CONTROLS,
    encodeToolContinuation: () => ({}),
    encodeContextUpdate: () => EMPTY_CONTROLS,
    encodeTextTurn: () => EMPTY_CONTROLS,
  };
  return Object.freeze(registration);
}

export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    PLUGIN_MANIFEST.contributes.voiceProviders[0].id,
    createCodexRealtimeVoiceProviderRuntimeRegistration(),
  );
}
