import { DaemonVoiceClientAccountOperationRequestV1Schema, DaemonVoiceClientAccountOperationResponseV1Schema, type DaemonVoiceClientMediatedCredentialDeclarationAuthorityV1 } from '@happier-dev/protocol/daemon/voiceCredentials';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { VoiceAccountOperationService } from '@happier-dev/plugin-sdk/voice';
import { decodeBase64 } from '@/encryption/base64';

import { log } from '@/log';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

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

export function createVoiceClientAccountOperationExecutor(input: Readonly<{
  contribution: PluginContributionIdentityV1;
  platform: 'web' | 'ios' | 'android';
  phase: 'settings' | 'prepare' | 'connection';
  /** The exact contribution declaration this client runtime was activated from. */
  declarationAuthority: DaemonVoiceClientMediatedCredentialDeclarationAuthorityV1;
  /** Exact daemon target captured with the credential-source authority. */
  machineId: string | null;
  isCurrent(): boolean;
  /** Captured machine/source authority for this exact host invocation. */
  isInvocationCurrent(): boolean;
  client?: SelectedVoiceMachineClient;
}>) {
  const machineId = input.machineId;
  const client = input.client
    ?? createSelectedVoiceMachineClient({ resolveMachineId: () => machineId });
  return async (request: Readonly<{
    operationId: string;
    parameters: Parameters<VoiceAccountOperationService['request']>[0]['parameters'];
    /** The Connected Account selection this operation was authorized under. */
    selection: QualifiedConnectedAccountPurposeBindingTargetV1;
    signal: AbortSignal;
  }>): ReturnType<VoiceAccountOperationService['request']> => {
    /**
     * This is the only Voice pre-flight step that runs before any provider
     * request or microphone acquisition, so a failure here is invisible at the
     * surface (every Voice error renders as "Connection Error"). Name the
     * failing step and its cause exactly once. Neither source credentials nor
     * provider response bytes are part of the record.
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
    const parsedRequest = DaemonVoiceClientAccountOperationRequestV1Schema.safeParse({
      contribution: input.contribution,
      platform: input.platform,
      phase: input.phase,
      operationId: request.operationId,
      parameters: request.parameters,
      declarationAuthority: input.declarationAuthority,
      expectedSelection: request.selection,
    });
    if (!parsedRequest.success) {
      throw failure('request', 'voice_account_operation_unauthorized', 'request_invalid');
    }
    if (!input.isCurrent() || !input.isInvocationCurrent()) {
      throw operationError('voice_account_operation_cancelled');
    }
    throwIfAborted(request.signal);
    let raw: unknown;
    try {
      raw = await client.invoke(
        RPC_METHODS.DAEMON_VOICE_CLIENT_ACCOUNT_OPERATION,
        parsedRequest.data,
        request.signal,
      );
    } catch (error) {
      throwIfAborted(request.signal);
      const cause = readSafeCause(error);
      throw failure(
        'machine_rpc',
        cause === 'machine_unavailable' ? 'execution_machine_unavailable' : 'credential_unavailable',
        cause,
      );
    }
    throwIfAborted(request.signal);
    if (!input.isCurrent() || !input.isInvocationCurrent()) {
      throw operationError('voice_account_operation_cancelled');
    }
    const response = DaemonVoiceClientAccountOperationResponseV1Schema.safeParse(raw);
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
    return Object.freeze({
      status: response.data.response.status,
      finalUrl: response.data.response.finalUrl,
      headers: Object.freeze({ ...response.data.response.headers }),
      body: decodeBase64(response.data.response.bodyBase64, 'base64'),
    });
  };
}
