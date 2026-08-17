import {
  DaemonVoiceClientMediatedCredentialMaterializeRequestV1Schema,
  DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { log } from '@/log';

import { createSelectedVoiceMachineClient } from './selectedMachineClient';

type SelectedVoiceMachineClient = Readonly<{
  invoke(method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown>;
}>;

/** Mirrors the safe-code shape the Voice failure surfaces already admit. */
const SAFE_CAUSE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

function operationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function readSafeCause(error: unknown): string {
  const code = (error as Readonly<{ code?: unknown }> | null)?.code;
  if (typeof code !== 'string') return 'unknown';
  const normalized = code.trim();
  return SAFE_CAUSE_PATTERN.test(normalized) ? normalized : 'unknown';
}

export function createVoiceClientMediatedCredentialHeadersMaterializer(input: Readonly<{
  contribution: PluginContributionIdentityV1;
  platform: 'web' | 'ios' | 'android';
  phase: 'settings' | 'prepare' | 'connection';
  isCurrent(): boolean;
  client?: SelectedVoiceMachineClient;
}>) {
  const client = input.client ?? createSelectedVoiceMachineClient();
  return async (request: Readonly<{
    operationId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<Record<string, string>>> => {
    /**
     * This is the only Voice pre-flight step that runs before any provider
     * request or microphone acquisition, so a failure here is invisible at the
     * surface (every Voice error renders as "Connection Error"). Name the
     * failing step and its cause exactly once. Materialized headers are the
     * credential itself and are never part of the record.
     */
    const failure = (stage: string, code: string, cause: string): Error => {
      log.log(`[voiceMediatedCredential] ${JSON.stringify({
        pluginId: input.contribution.pluginId,
        localId: input.contribution.localId,
        phase: input.phase,
        operationId: request.operationId,
        stage,
        cause,
        code,
      })}`);
      return operationError(code);
    };
    const parsedRequest = DaemonVoiceClientMediatedCredentialMaterializeRequestV1Schema.safeParse({
      contribution: input.contribution,
      platform: input.platform,
      phase: input.phase,
      operationId: request.operationId,
    });
    if (!parsedRequest.success) {
      throw failure('request', 'voice_account_operation_unauthorized', 'request_invalid');
    }
    if (!input.isCurrent()) throw operationError('voice_account_operation_cancelled');
    request.signal.throwIfAborted();
    let raw: unknown;
    try {
      raw = await client.invoke(
        RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE,
        parsedRequest.data,
        request.signal,
      );
    } catch (error) {
      request.signal.throwIfAborted();
      throw failure('machine_rpc', 'credential_unavailable', readSafeCause(error));
    }
    request.signal.throwIfAborted();
    if (!input.isCurrent()) throw operationError('voice_account_operation_cancelled');
    const response = DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema.safeParse(raw);
    if (!response.success) {
      throw failure('response', 'provider_response_invalid', 'response_malformed');
    }
    if (!response.data.ok) {
      throw failure(
        'daemon_rejected',
        response.data.errorCode === 'plugin_voice_provider_result_invalid'
          ? 'voice_account_operation_unauthorized'
          : response.data.errorCode === 'plugin_voice_provider_operation_failed'
            ? 'provider_response_invalid'
            : 'credential_unavailable',
        response.data.errorCode,
      );
    }
    return Object.freeze({ ...response.data.headers });
  };
}
