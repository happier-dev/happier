import type { PluginApi, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { ActionFailureCauseV1Schema } from '@happier-dev/plugin-sdk/errors';
import type {
  RealtimeVoiceProviderProtocol,
  RealtimeVoiceProviderRuntime,
  VoiceProviderExecutionAuthority } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice/client';

import { CODEX_VOICE_PROVIDER_CONTRIBUTION_ID } from '../../constants.js';
import {
  createCodexV3ControlDecoder,
  encodeCodexV3ContextUpdate,
  type CodexV3ControlDecoder,
} from './control.js';

const CONTROL_CHANNEL_LABEL = 'oai-events';
const EMPTY_CONTROLS = Object.freeze([]) as readonly VoiceRealtimeJsonValue[];
type AgentSessionRealtimeStartResult = Awaited<ReturnType<
  Extract<
    VoiceProviderExecutionAuthority,
    Readonly<{ kind: 'experimental_agent_session_realtime' }>
  >['agentSessionRealtime']['start']
>>;
const START_REMEDIATION_BY_DIAGNOSTIC_CODE = Object.freeze({
  codex_realtime_authentication_required: 'authentication_required',
  codex_realtime_agent_session_disposed: 'session_unavailable',
  codex_realtime_session_disposed: 'session_unavailable',
  codex_realtime_runtime_exited: 'session_unavailable',
  codex_realtime_thread_unavailable: 'session_unavailable',
  codex_realtime_thread_changed: 'session_unavailable',
  codex_realtime_runtime_unavailable: 'unsupported_runtime',
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

function agentRealtimeError(code: string, message: string, diagnostic?: PluginDiagnosticData): Error & Readonly<{ code: string }> {
  const details = diagnostic?.details;
  const cause = ActionFailureCauseV1Schema.safeParse(details && typeof details === 'object' && 'failureCause' in details
    ? details.failureCause : undefined);
  return Object.assign(new Error(message), { code, ...(cause.success ? { failureCause: cause.data } : {}) });
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

export function createCodexRealtimeVoiceProviderRuntime(): RealtimeVoiceProviderRuntime {
  const activeAttemptsById = new Map<number, Readonly<{
    attemptId: number;
    decoder: CodexV3ControlDecoder;
  }>>();
  let currentAttemptId: number | null = null;

  const protocol: RealtimeVoiceProviderProtocol = Object.freeze({
    async preflight({ signal }) {
      return signal.aborted ? { kind: 'aborted' } : { kind: 'ready' };
    },
    async prepare({ signal }) {
      if (signal.aborted) return { kind: 'aborted' };
      return {
        kind: 'prepared',
        session: {
          config: {},
          safeMetadata: {},
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
  const runtime: RealtimeVoiceProviderRuntime = {
    kind: 'conversation',
    protocol,
    microphoneMode: 'host_webrtc',
    outputLevelMeter: 'unavailable',
    async createConnection({ attemptId, media, signal, execution, ui }) {
      if (execution.kind !== 'experimental_agent_session_realtime') {
        throw new Error('voice_agent_realtime_execution_authority_required');
      }
      const availability = await execution.agentSessionRealtime.inspect({ signal });
      if (availability.status !== 'available') {
        throw agentRealtimeError(
          availability.reason,
          `voice_agent_realtime_${availability.reason}:${availability.diagnostic.code}`,
          availability.diagnostic,
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
                diagnostic,
              );
            }
            decoder.markStarted();
            return { answerSdp: result.transport.answerSdp };
          },
        },
        control: {
          label: CONTROL_CHANNEL_LABEL,
          // App-server configures the native session and owns delegation.
          // A GA session/tools update here would overwrite a different wire.
          onOpen() {},
        },
      });
    },
    // Native delegation never enters the host's GA client-function path.
    encodeToolResults: () => EMPTY_CONTROLS,
    encodeToolContinuation: () => null,
    encodeContextUpdate: encodeCodexV3ContextUpdate,
    encodeTextTurn: () => EMPTY_CONTROLS,
  };
  return Object.freeze(runtime);
}

export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    CODEX_VOICE_PROVIDER_CONTRIBUTION_ID,
    createCodexRealtimeVoiceProviderRuntime(),
  );
}
