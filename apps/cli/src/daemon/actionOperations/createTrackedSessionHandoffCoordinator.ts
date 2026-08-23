import {
  normalizeSpawnSessionNonceResolution,
  SpawnSessionExecutionAuthorizationSchema,
  type ActionExecuteResult,
  type SessionHandoffStorageMode,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { StoredCredentials } from '@/persistence';
import { resolveSessionHandoffSourceAuthority } from '@/session/handoff/resolveSessionHandoffSourceAuthority';
import { awaitSpawnedSessionId } from '@/session/services/awaitSpawnedSessionId';
import { buildMachineResumeRequest } from '@/session/services/requestInactiveSessionResume';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';

import type { ActionOperationOwnerUpdate } from './actionOperationTypes';
import { coordinateTrackedSessionHandoff } from './sessionHandoffCoordinator';

type SourceContext =
  | Readonly<{ ok: true; sourceMachineId: string; sessionStorageMode: SessionHandoffStorageMode }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type MachineCall = (input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  method: string;
  request: unknown;
  signal?: AbortSignal;
}>) => Promise<unknown>;

type CoordinatorDeps = Readonly<{
  readCredentials: () => Promise<StoredCredentials | null>;
  resolveSource?: (
    credentials: StoredCredentials,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SourceContext>;
  callMachine?: MachineCall;
  awaitTargetCustody?: (input: Readonly<{
    credentials: StoredCredentials;
    machineId: string;
    sessionId: string;
    spawnNonce: string;
    spawnResult: unknown;
    signal: AbortSignal;
  }>) => Promise<Readonly<{ type: 'success'; sessionId: string } | { type: 'error'; errorCode: string; errorMessage: string }>>;
  wait?: (signal: AbortSignal) => Promise<void>;
}>;

type HostCoordinatorInput = Readonly<{
  actionInput: unknown;
  start: () => Promise<ActionExecuteResult>;
  signal: AbortSignal;
  publishOwnerUpdate: (update: ActionOperationOwnerUpdate) => void;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function resolveSourceContext(
  credentials: StoredCredentials,
  sessionId: string,
  signal: AbortSignal,
): Promise<SourceContext> {
  const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId, signal });
  if (!transport.ok) {
    return { ok: false, errorCode: transport.code, error: transport.code };
  }
  return resolveSessionHandoffSourceAuthority({
    credentials,
    rawSession: transport.rawSession,
    accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
  });
}

async function waitForTargetCustody(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  sessionId: string;
  spawnNonce: string;
  spawnResult: unknown;
  signal: AbortSignal;
}>): Promise<Readonly<{ type: 'success'; sessionId: string } | { type: 'error'; errorCode: string; errorMessage: string }>> {
  return await awaitSpawnedSessionId({
    result: input.spawnResult,
    spawnNonce: input.spawnNonce,
    resolveSpawnSessionByNonce: async (spawnNonce, timeoutMs) => normalizeSpawnSessionNonceResolution(
      await callMachineRpc({
        credentials: input.credentials,
        machineId: input.machineId,
        method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
        request: { spawnNonce },
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
        signal: input.signal,
      }),
    ),
    signal: input.signal,
  });
}

export function createTrackedSessionHandoffCoordinator(deps: CoordinatorDeps) {
  const resolveSource = deps.resolveSource ?? resolveSourceContext;
  const callMachine: MachineCall = deps.callMachine ?? (async (input) => await callMachineRpc(input));
  const awaitTargetCustody = deps.awaitTargetCustody ?? waitForTargetCustody;

  return async (hostInput: HostCoordinatorInput): Promise<ActionExecuteResult> => {
    const rawInput = hostInput.actionInput && typeof hostInput.actionInput === 'object'
      && !Array.isArray(hostInput.actionInput)
      ? hostInput.actionInput as Readonly<Record<string, unknown>>
      : {};
    const sessionId = readNonEmptyString(rawInput.sessionId);
    const targetMachineId = readNonEmptyString(rawInput.targetMachineId);
    if (!sessionId || !targetMachineId) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const credentials = await deps.readCredentials();
    if (!credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    let spawnResult: unknown;
    let spawnNonce: string | null = null;
    const rpc = async (machineId: string, method: string, request: unknown, signal?: AbortSignal) => (
      await callMachine({ credentials, machineId, method, request, ...(signal ? { signal } : {}) })
    );

    return await coordinateTrackedSessionHandoff({
      input: {
        sessionId,
        targetMachineId,
        ...(rawInput.targetSessionStorageMode === 'direct' || rawInput.targetSessionStorageMode === 'persisted'
          ? { targetSessionStorageMode: rawInput.targetSessionStorageMode }
          : {}),
        ...(rawInput.workspaceTransfer && typeof rawInput.workspaceTransfer === 'object'
          ? { workspaceTransfer: rawInput.workspaceTransfer as never }
          : {}),
      },
      signal: hostInput.signal,
      start: hostInput.start,
      resolveSource: async (id, signal) => await resolveSource(credentials, id, signal),
      prepareTarget: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
        request,
        signal,
      ),
      getPreparedTargetResult: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET,
        request,
        signal,
      ),
      getTargetStatus: async (request, signal) => await rpc(
        targetMachineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET,
        request,
        signal,
      ),
      resumeTarget: async ({ sessionId: resumeSessionId, prepared }, signal) => {
        spawnNonce = createStableSpawnNonce('session.handoff.target', { handoffId: prepared.handoffId });
        const options: SpawnSessionOptions = {
          machineId: targetMachineId,
          directory: prepared.resume!.directory,
          backendTarget: { kind: 'backend', backendId: prepared.resume!.agent },
          resume: prepared.resume!.resume,
          attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
          transcriptStorage: prepared.resume!.transcriptStorage,
          executionAuthorization: SpawnSessionExecutionAuthorizationSchema.parse({
            provenance: 'user_request',
            requestId: prepared.handoffId,
          }),
          ...(prepared.runtimeDescriptorV1 ? { runtimeDescriptorV1: prepared.runtimeDescriptorV1 } : {}),
          ...(prepared.resume!.environmentVariables
            ? { environmentVariables: prepared.resume!.environmentVariables }
            : {}),
          ...(prepared.resume!.codexBackendMode
            ? { codexBackendMode: prepared.resume!.codexBackendMode }
            : {}),
        };
        spawnResult = await rpc(
          targetMachineId,
          RPC_METHODS.SPAWN_HAPPY_SESSION,
          buildMachineResumeRequest(options, resumeSessionId, spawnNonce),
          signal,
        );
        const record = spawnResult && typeof spawnResult === 'object'
          ? spawnResult as Readonly<Record<string, unknown>>
          : null;
        return record?.type === 'success'
          ? { ok: true }
          : {
              ok: false,
              errorCode: readNonEmptyString(record?.errorCode) ?? 'session_handoff_resume_failed',
              error: readNonEmptyString(record?.errorMessage) ?? 'session_handoff_resume_failed',
            };
      },
      confirmTarget: async ({ sessionId: expectedSessionId }) => {
        if (!spawnNonce) {
          return { ok: false, errorCode: 'session_handoff_target_unconfirmed', error: 'session_handoff_target_unconfirmed' };
        }
        const settled = await awaitTargetCustody({
          credentials,
          machineId: targetMachineId,
          sessionId: expectedSessionId,
          spawnNonce,
          spawnResult,
          signal: hostInput.signal,
        });
        return settled.type === 'success' && settled.sessionId === expectedSessionId
          ? { ok: true }
          : {
              ok: false,
              errorCode: settled.type === 'error' ? settled.errorCode : 'session_handoff_target_unconfirmed',
              error: settled.type === 'error' ? settled.errorMessage : 'session_handoff_target_unconfirmed',
            };
      },
      commitTarget: async ({ machineId, ...request }, signal) => await rpc(
        machineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
        request,
        signal,
      ),
      cleanupSource: async ({ machineId, ...request }, signal) => await rpc(
        machineId,
        RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
        request,
        signal,
      ),
      abort: async ({ machineId, ...request }) => {
        return await rpc(machineId, RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, request);
      },
      publishOwnerUpdate: hostInput.publishOwnerUpdate,
      ...(deps.wait ? { wait: deps.wait } : {}),
    });
  };
}
