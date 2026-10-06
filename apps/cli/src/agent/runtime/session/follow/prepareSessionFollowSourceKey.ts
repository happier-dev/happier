import { SessionFollowSourceKeyPrepareResponseV1Schema, buildSessionFollowSourceKeyPrepareRequestV1, resolveSessionFollowSourceKeyPreparationFailureV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { encodeBase64 } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { resolveExpectedRunnerMachineContentKeyBindingScope } from '@/api/machine/machineDataEncryptionKey';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';

/**
 * Sends one source Session DEK to the exact destination Machine. Replacement
 * resolution is intentionally impossible here; server admission validates the
 * same source/destination tuple carried outside and inside the encrypted body.
 */
export async function prepareSessionFollowSourceKey(input: Readonly<{
  credentials: StoredCredentials;
  homeServerIdentityId: string;
  machineId: string;
  sourceSessionId: string;
  destinationSessionId: string;
  sourceDataEncryptionKey: Uint8Array;
  serverUrl?: string;
  signal?: AbortSignal;
  externalAction?: Readonly<{
    context: ActionExecutorContext;
    effectActionId: string;
    installationId: string;
    privateKey: ExternalActionMachineRequestSigningKey;
  }>;
}>): Promise<SessionFollowSourceKeyPreparationResultV1> {
  const { authorization, request } = buildSessionFollowSourceKeyPrepareRequestV1({
    sourceSessionId: input.sourceSessionId,
    destinationSessionId: input.destinationSessionId,
    sourceDataEncryptionKeyBase64: encodeBase64(input.sourceDataEncryptionKey),
  });
  const expectedRunnerMachineContentKeyBinding = resolveExpectedRunnerMachineContentKeyBindingScope({
    credentials: input.credentials,
    homeServerIdentityId: input.homeServerIdentityId,
    machineId: input.machineId,
  });
  try {
    const response = await callExactMachineRpc({
      credentials: input.credentials,
      machineId: input.machineId,
      method: RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE,
      request,
      authorization,
      expectedEncryptionMode: 'e2ee',
      ...(expectedRunnerMachineContentKeyBinding
        ? { expectedRunnerMachineContentKeyBinding }
        : {}),
      requireCurrentMachine: true,
      requiredMachineKind: 'ephemeral_session_runner',
      ...(input.externalAction ? { externalAction: input.externalAction } : {}),
      ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    SessionFollowSourceKeyPrepareResponseV1Schema.parse(response);
    return { kind: 'prepared' };
  } catch (error) {
    // One classification for both DEK-sending hosts; the UI leaf calls the same
    // Protocol owner after its own store-backed pre-checks.
    return resolveSessionFollowSourceKeyPreparationFailureV1(error);
  }
}
