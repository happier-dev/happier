import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import axios from 'axios';
// Load the real dynamic Machine API graph during collection, not the test deadline.
import '@/api/api';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineSessionHandoffRpcHandlers } from '@/api/machine/sessionHandoff/handlers';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, subscribeActiveProjectAccountRowsSnapshot,
  withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { ProjectAccountRowV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createDaemonWorkspaceSyncRuntime';
import { withTempDir } from '@/testkit/fs/tempDir';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createApiSessionSocketStub, bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import nacl from 'tweetnacl';
import { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { buildActionExecutorContextForRpc, projectWorkspaceSyncPhysicalContextFromActionContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import { createSessionHandoffPrepareTargetJobStore } from '@/session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createRequesterSessionCredentialCustody, resolveRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { verifyMachineInstallationProof, MachineInstallationProofV1Schema,
  MachineInstallationProofPayloadV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { assertResolvedHomeTargetIdentity, resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketIo }));

import {
  buildTrackedSessionHandoffSpawnOptions,
  createTrackedSessionHandoffCoordinator,
} from './createTrackedSessionHandoffCoordinator';
import {
  computeWorkspaceSyncPolicyDigest,
  type ManagedWorkspaceSync,
  type WorkspaceSyncStatusV1,
} from '@/workspaces/sync/workspaceSyncTypes';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';

type MachineCallInput = Parameters<NonNullable<Parameters<typeof createTrackedSessionHandoffCoordinator>[0]['callMachine']>>[0];

const transferCapability = { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false };

afterEach(() => { vi.restoreAllMocks(); socketIo.mockReset(); withdrawActiveProjectAccountRowsSnapshot(); });

function ordinaryMachineHttpBoundary() {
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    const id = new URL(String(url)).pathname.split('/').at(-1);
    return { status: 200, data: { machine: { id, active: true, installationId: `${id}-installation`,
      metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      devcontainerChild: null,
      metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/user',
        happyHomeDir: '/home/user/.happier', happyCliVersion: 'source-fixture' }) } } };
  });
}

function handoffSourceHttpBoundary(sessionId: string) {
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
      encryptionMode: 'plain', dataEncryptionKey: null, share: null,
      metadata: JSON.stringify({ machineId: 'source', path: '/source', codexSessionId: 'native-session' }) }) } };
    throw new Error(`Unexpected Home read ${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    if (!config.url) throw new Error('Missing Home URL');
    return await axios.get(config.url, config);
  });
}

function createSandboxHandoffTarget(activeServerDir: string) {
  const target = new RpcHandlerManager({ scopePrefix: 'target', localMachineId: 'target', encryptionMode: 'plain',
    authorizeRequest: async () => ({ ok: true }), logger: () => undefined });
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager: target, localMachineId: 'target', runtimeConfig: { activeServerDir },
    readHandoffTargetMachineMetadata: () => ({ status: 'ready', metadataVersion: 1, metadata: { isolationPolicyV1: {
      configuredSandboxes: { local: { provisioner: { pluginId: 'custom.compute', localId: 'lima' }, presetId: 'local-preset' } },
      workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'local', lifecycle: 'fresh' },
        botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } },
    } } }),
  });
  return target;
}

describe('createTrackedSessionHandoffCoordinator', () => {
  it.each([['source', 'source'], ['target', 'source'], ['source', 'observer']])('uses the same-process preparation writer wakeup for target %s on host %s', async (targetMachineId, localMachineId) => {
    await withTempDir('handoff-local-status-owner-', async activeServerDir => {
      const sessionId = `c${'d'.repeat(24)}`;
      handoffSourceHttpBoundary(sessionId);
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const status = { handoffId: 'handoff-local', jobId: 'prepare_local', status: 'pending' as const,
        phase: 'staging_target' as const, transportStrategy: 'server_routed_stream' as const, recoveryActions: [] };
      const record = { jobId: status.jobId, handoffId: status.handoffId, createdAtMs: 1, updatedAtMs: 1, status };
      await store.write(record);
      let statusReads = 0;
      let firstStatusRead!: () => void;
      const observed = new Promise<void>(resolve => { firstStatusRead = resolve; });
      const callMachine = async (input: MachineCallInput) => {
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) return { handoffId: status.handoffId, status };
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3) {
          statusReads++;
          const current = await store.read(status.jobId);
          firstStatusRead();
          return { handoffId: status.handoffId, status: current?.status };
        }
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3) return { ok: false, errorCode: 'source_export_failed', error: 'Source export failed' };
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3) return { handoffId: status.handoffId, status: { ...status, status: 'aborted' } };
        throw new Error(`Unexpected Machine method ${input.method}`);
      };
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'server-1',
        readCredentials: async () => ({ token: 'token', encryption: null }), callMachine,
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never,
          bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
      });
      const controller = new AbortController();
      const timers = vi.spyOn(globalThis, 'setTimeout');
      let localWaits = 0;
      const operation = coordinate({ operationId: 'local-operation', actionInput: { sessionId, targetMachineId, targetPath: '/source' },
        signal: controller.signal, publishOwnerUpdate: () => undefined,
        start: async () => ({ ok: true, result: { handoffId: status.handoffId, targetPath: '/source', endpointCandidates: [],
          status: { ...status, phase: 'preparing' } } }),
        localPreparation: { machineId: localMachineId, waitForChange: (observedStatus, signal) => {
          localWaits++;
          return store.waitForChange({ jobId: status.jobId, observedStatus, signal });
        } },
      });
      try {
        const reachedObservation = await Promise.race([observed.then(() => true), operation]);
        expect(reachedObservation).toBe(true);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(timers.mock.calls.filter(([, delay]) => delay === 500)).toHaveLength(targetMachineId === localMachineId ? 0 : 1);
        expect(localWaits).toBe(targetMachineId === localMachineId ? 1 : 0);
        expect(statusReads).toBe(1);
        await store.write({ ...record, updatedAtMs: 2, status: { ...status, status: 'awaiting_recovery' } });
        await expect(operation).resolves.toMatchObject({ ok: false, errorCode: 'source_export_failed' });
        expect(statusReads).toBe(2);
      } finally {
        controller.abort();
        await operation;
        timers.mockRestore();
      }
    });
  });
  it.each(['existing_session_state_unavailable', 'handoff_existing_state_update_required'])('refuses %s before stopping the source through the target preflight transport', async errorCode => {
    const sessionId = `c${'d'.repeat(24)}`;
    handoffSourceHttpBoundary(sessionId);
    const callMachine = vi.fn(async (input: { method: string }) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true };
      if (errorCode === 'handoff_existing_state_update_required') throw createRpcCallError({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });
      return { ok: false, errorCode };
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1', readCredentials: async () => ({ token: 'token', encryption: null }), callMachine,
      workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never, bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
    });
    const start = vi.fn(async () => ({ ok: false as const, errorCode: 'source_stopped', error: 'source_stopped' }));
    const result = await coordinate({ operationId: 'operation-existing',
      actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target', stateTransfer: 'existing', workspaceAction: { kind: 'none' } },
      start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, errorCode });
    expect(start).not.toHaveBeenCalled();
    expect(callMachine).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'target',
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3,
      request: expect.objectContaining({ kind: 'requester_session_handoff_preflight_bootstrap_v1',
        input: { sessionId, sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/target', sourceSessionStorageMode: 'persisted' },
      }),
    }));
  });

  it.each(['source', 'target'])('negotiates %s capability before any source mutation', async unsupportedMachineId => {
    const sessionId = `c${'e'.repeat(24)}`;
    handoffSourceHttpBoundary(sessionId);
    const callMachine = vi.fn(async (input: { machineId: string; method: string }) => input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET
      ? { protocolVersion: input.machineId === unsupportedMachineId ? 2 : 3, atomicTargetResume: false, targetCleanup: false, existingState: true }
      : { ok: true });
    const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }), callMachine,
      workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never, bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
    });
    const start = vi.fn(async () => ({ ok: false as const, errorCode: 'source_stopped', error: 'source_stopped' }));
    expect(await coordinate({ operationId: 'operation-existing',
      actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target', stateTransfer: 'existing' },
      start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
    })).toMatchObject({ ok: false, errorCode: 'handoff_existing_state_update_required' });
    expect(start).not.toHaveBeenCalled();
    expect(callMachine).not.toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3 }));
  });

  it('refuses an ordinary same-Account transfer to a bare sandbox Machine before starting the source', async () => {
    await withTempDir('handoff-own-bare-sandbox-', async activeServerDir => {
      const sessionId = `c${'g'.repeat(24)}`;
      handoffSourceHttpBoundary(sessionId);
      const target = createSandboxHandoffTarget(activeServerDir);
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'server-1',
        readCredentials: async () => ({ token: 'owner-token', encryption: null }),
        callMachine: async ({ machineId, method, request }) => {
          expect(machineId).toBe('target');
          return await target.invokeLocal(method, request, { rpcContext: {
            machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'target',
              installationId: 'target-installation', role: 'manage' },
          } });
        },
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never,
          bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
      });
      const start = vi.fn(async () => ({ ok: false as const, errorCode: 'source_stopped', error: 'source_stopped' }));
      const result = await coordinate({ operationId: 'ordinary-transfer',
        actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target', stateTransfer: 'transfer' },
        start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'handoff_target_requires_sandbox_preset' });
      expect(start).not.toHaveBeenCalled();
    });
  });

  it.each(['existing', 'transfer'] as const)('preflights an accepted %s handoff before the source stops', async stateTransfer => {
    await withTempDir('handoff-read-only-root-', async activeServerDir => {
      const sessionId = `c${'f'.repeat(24)}`;
      handoffSourceHttpBoundary(sessionId);
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'accepted-root', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob',
        machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
        requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
        handoffAdmission: { sessionId, sourceMachineId: 'source', targetMachineId: 'target',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } });
      vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        expect(request.handoffPreflight).toEqual({ authorization: root });
        expect(request).not.toHaveProperty('handoffContinuation');
        const machineId = request.machineId;
        return { status: 200, data: { v: 1, token: `read-child-${machineId}`, binding: { ...root.binding,
          machineId, installationId: `${machineId}-installation`, target: request.envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          handoffPreflight: { rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest },
        } } };
      });
      const targetDaemon = createSandboxHandoffTarget(activeServerDir);
      const callMachine = vi.fn(async (input: MachineCallInput) => {
        const signed = input.externalAction;
        expect(signed?.effectActionId).toBe('session.handoff');
        const authorization = signed?.context.externalActionExecutionAuthorization;
        expect(authorization?.binding.handoffPreflight).toEqual({
          rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest,
        });
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) {
          if (stateTransfer === 'transfer' && input.machineId === 'target') {
            if (!authorization) throw new Error('Missing verified peer preflight');
            return await targetDaemon.invokeLocal(input.method, input.request, { rpcContext: { callerInputAuthorization: authorization } });
          }
          return { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true };
        }
        expect(input.request).toMatchObject({ kind: 'requester_session_handoff_preflight_bootstrap_v1',
          input: { sessionId, sourceMachineId: 'source', targetMachineId: 'target' },
          requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'requester-token' } },
        });
        return { ok: false, errorCode: 'existing_session_state_unavailable' };
      });
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'server-1',
        readCredentials: async () => ({ token: 'requester-token', encryption: null }), callMachine,
        handoffAuthorization: { sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
          serverHttpBaseUrl: 'http://requester-home.invalid', readSourceInstallation: () => ({
            machineId: 'source', installationId: 'source-installation', privateKey: keys.secretKey,
          }) },
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never, bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
      });
      const start = vi.fn(async () => ({ ok: false as const, errorCode: 'source_stopped', error: 'source_stopped' }));
      expect(await coordinate({ operationId: 'original-request',
        actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target', stateTransfer },
        start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
        context: { externalActionExecutionAuthorization: root },
      })).toMatchObject({ ok: false, errorCode: stateTransfer === 'existing'
        ? 'existing_session_state_unavailable' : 'handoff_target_requires_sandbox_preset' });
      expect(start).not.toHaveBeenCalled();
      expect(callMachine).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'target', method: stateTransfer === 'existing'
        ? RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3 : RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET }));
    });
  });

  it.each(['refuses without sending requester custody', 'continuation', 'different custody root',
    'rotated signer', 'linked_workspace', 'relationship', 'retired_linked_workspace'] as const)(
    'handles a cold requester handoff: %s', async scenario => {
    let phase = 'prepare requester custody and Home boundaries';
    onTestFailed(() => console.error('Cold requester Project handoff fixture failed', { scenario, phase }));
    await withTempDir('handoff-requester-continuation-', async activeServerDir => {
      const sessionId = `c${'b'.repeat(24)}`;
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
      const targetKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(33));
      const targetCustodian = scenario === 'refuses without sending requester custody' ? 'carol' : 'alice';
      const continuationRefused = scenario === 'different custody root' || scenario === 'rotated signer';
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'accepted-original-root', binding: {
        accountId: 'bob', accountEncryptionMode: 'plain', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob',
        machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
        requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 1, turnDepth: 2 },
          callerPermissionMode: 'default', sourceTurnId: 'original-turn', requestId: 'original-request' },
        sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
        handoffAdmission: { sessionId, sourceMachineId: 'source', targetMachineId: 'target',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } });
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const loadCustody = vi.spyOn(store, 'load');
      await store.save({ handoffId: 'handoff-cold', sessionId, sourceMachineId: 'source', targetMachineId: 'target',
        exportedAtMs: 1, acceptedHandoffAuthorization: scenario === 'different custody root'
          ? { ...root, token: 'a-different-accepted-root' } : root });
      let continuationMints = 0;
      // Only Home HTTP and the target Machine transport are substituted.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'bob' } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        if (path === '/v1/machines/source' || path === '/v1/machines/target') {
          const id = path.split('/').at(-1)!;
          return { status: 200, data: { machine: { id, active: true, installationId: `${id}-installation`,
            installationPublicKey: Buffer.from(id === 'target' ? targetKeys.publicKey : keys.publicKey).toString('base64'),
            access: { custodian: { accountId: id === 'target' ? targetCustodian : 'alice',
              displayName: id === 'target' && targetCustodian === 'carol' ? 'Carol' : 'Alice' },
            role: 'use', resourceMode: 'plain', accessState: 'ready' },
            metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            devcontainerChild: null, metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/user',
              happyHomeDir: '/home/user/.happier', happyCliVersion: 'source-fixture' }) } } };
        }
        if (path === '/v1/machines/source/access') return { status: 200, data: { machineId: 'source',
          custodian: { accountId: 'alice', displayName: 'Alice' }, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'use', resourceMode: 'plain', accessState: 'ready' }, canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [] } };
        if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
          share: null, encryptionMode: 'plain', dataEncryptionKey: null,
          metadata: JSON.stringify({ machineId: 'source', path: '/source', codexSessionId: 'same-native' }) }) } };
        throw new Error(`Unexpected requester Home read ${path}`);
      });
      vi.spyOn(axios, 'request').mockImplementation(async config => {
        expect(config.method?.toUpperCase()).toBe('GET');
        if (!config.url) throw new Error('Missing requester Home URL');
        return await axios.get(config.url, config);
      });
      const installedRefs = [
        { id: 'installed-source', serverId: 'bob-home', machineId: 'source', rootPath: join(activeServerDir, 'installed-source'), createdAtMs: 1 },
        { id: 'installed-target', serverId: 'bob-home', machineId: 'target', rootPath: join(activeServerDir, 'installed-target'), createdAtMs: 1 },
      ];
      await Promise.all(installedRefs.map(ref => mkdir(ref.rootPath)));
      const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const relationship = { v: 1 as const, relationshipId: 'installed-relationship', controllerMachineId: 'source',
        alphaWorkspaceRefId: installedRefs[0]!.id, betaWorkspaceRefId: installedRefs[1]!.id, mode: 'keep_synced' as const,
        enabled: false, createdAtMs: 1, updatedAtMs: 1,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } };
      const graphKey = { kind: 'relationship-graph' as const };
      const installedRows = [...installedRefs.map(ref => createPlainProjectAccountRefRow(ref)),
        ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 1,
          content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } })];
      const requesterRows = Array.from({ length: 1024 }, (_, index) => {
        const key = { kind: 'project-organization' as const, serverId: 'bob-home', projectKey: `unrelated-${index}` };
        return { key, revision: 0, content: { t: 'plain', v: { key, value: { pinned: true } } } };
      });
      let requesterOrganizationBodies = 0;
      let retireDuringRead: (() => Promise<void>) | undefined;
      vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        if (new URL(String(url)).pathname.endsWith('/account/project-rows/list')) {
          const installed = config?.headers?.Authorization === 'Bearer installed-daemon';
          if (!installed) await retireDuringRead?.();
          const response = projectAccountRowsReadHttpResponse(installed ? installedRows : requesterRows, String(url), body);
          if (!installed) {
            if (!response.data.rows) throw new Error('Expected a Project list response');
            requesterOrganizationBodies += response.data.rows.length;
          }
          return response;
        }
        if (new URL(String(url)).pathname === '/v1/machines/source/admission/verify') {
          if (!body || typeof body !== 'object') throw new Error('Missing installed currentness proof');
          expect(Reflect.get(body, 'purpose')).toEqual({ kind: 'requester_session_currentness', sessionId });
          expect(body).not.toHaveProperty('method');
          const payload = MachineInstallationProofPayloadV1Schema.parse({
            version: 1, accountId: 'alice', machineId: 'source', installationId: 'source-installation',
            rpcAdmission: { context: Reflect.get(body, 'context'), purpose: Reflect.get(body, 'purpose') },
          });
          expect(verifyMachineInstallationProof({ publicKey: keys.publicKey,
            proof: MachineInstallationProofV1Schema.parse(Reflect.get(body, 'proof')), payload })).toBe(true);
          return { status: 200, data: { v: 1, ok: true } };
        }
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        if (request.handoffPreflight) {
          expect(request.handoffPreflight).toEqual({ authorization: root });
          return { status: 200, data: { v: 1, token: 'target-child', binding: { ...root.binding,
            machineId: 'target', custodianAccountId: targetCustodian, installationId: 'target-installation', target: request.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            handoffPreflight: { rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest },
          } } };
        }
        expect(request.handoffContinuation).toEqual({ authorization: root, handoffId: 'handoff-cold' });
        continuationMints++;
        return { status: 200, data: { v: 1, token: 'target-child', binding: { ...root.binding,
          machineId: request.machineId, installationId: `${request.machineId}-installation`, target: request.envelope.target,
          actionId: decodeURIComponent(new URL(String(url)).pathname.split('/')[3]!), requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          handoffContinuation: { rootRequestId: root.binding.requestId,
            rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest, handoffId: 'handoff-cold' },
        } } };
      });
      const credentialBinding = { happyHomeDir: activeServerDir, sessionId,
        attribution: { serverId: 'bob-home', accountId: 'bob', machineId: 'source', installationId: 'source-installation' } };
      await seedTestServerProfile({ id: credentialBinding.attribution.serverId,
        homeId: root.binding.serverIdentityId, serverUrl: 'https://bob-home.test' });
      await createRequesterSessionCredentialCustody({ ...credentialBinding,
        homeServerIdentityId: root.binding.serverIdentityId, credentials: { token: 'bob-ordinary', encryption: null } });
      phase = 'admit requester Session bootstrap';
      const requester = await resolveRequesterSessionBootstrap({ ...credentialBinding, serverHttpBaseUrl: 'https://bob-home.test',
        machineAdmissionBoundary: { machineId: 'source', daemonToken: 'alice-daemon', isHomeCurrent: () => true,
          readInstallation: () => ({ installationId: 'source-installation', privateKey: keys.secretKey }) } });
      expect(requester).not.toBeNull();
      onTestFinished(() => requester?.dispose());
      if (scenario === 'refuses without sending requester custody') {
        phase = 'send the signed capability request to the foreign custodian';
        const target = createSandboxHandoffTarget(activeServerDir);
        const custodyOnWire: boolean[] = [];
        const answer = async (event: string, packet: unknown) => {
          if (event !== SOCKET_RPC_EVENTS.CALL || !packet || typeof packet !== 'object'
            || !('method' in packet) || typeof packet.method !== 'string' || !('params' in packet)
            || !('requestId' in packet) || typeof packet.requestId !== 'string') {
            throw new Error('Expected a Machine capability RPC');
          }
          expect(packet.method).toBe(`target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`);
          const execution = ExternalActionMachineRpcExecutionV1Schema.parse(Reflect.get(packet, 'externalActionExecution'));
          expect(execution.authorization.binding).toMatchObject({
            accountId: 'bob', custodianAccountId: 'carol', machineId: 'target', installationId: 'target-installation',
            handoffPreflight: { rootRequestId: root.binding.requestId },
          });
          expect(verifyExternalActionMachineRpcRequestV1({
            authorizationToken: execution.authorization.token, requesterAccountContext: execution.authorization.requesterAccountContext,
            effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
            method: packet.method, requestId: packet.requestId, params: packet.params,
            publicKey: keys.publicKey, signature: execution.machineSignature,
          })).toBe(true);
          const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
          custodyOnWire.push(execution.authorization.requesterAccountContext !== undefined
            || decoded.params !== null && typeof decoded.params === 'object' && 'requesterBootstrap' in decoded.params);
          return { ok: true, result: await target.handleRequest({
            method: packet.method, params: packet.params, callerInputAuthorization: execution.authorization,
            callerAuthority: resolveExternalActionRootInvocationAuthority(execution.authorization),
            sessionActionOrigin: execution.authorization.binding.sessionActionOrigin,
            machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'carol', machineId: 'target',
              installationId: 'target-installation', role: 'use', encryptionMode: 'plain' },
          }) };
        };
        bindApiSessionSocketMock(socketIo, createApiSessionSocketStub({
          emitWithAck: answer,
          emit: async (event, args) => {
            const response = await answer(event, args[0]);
            if (typeof args[1] !== 'function') throw new Error('Missing Machine RPC acknowledgement');
            args[1](response);
          },
        }));
        const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'bob-home',
          readCredentials: async () => requester!.credentials,
          handoffAuthorization: { sourceExportStore: store, serverHttpBaseUrl: 'https://bob-home.test',
            readSourceInstallation: () => ({ machineId: 'source', installationId: 'source-installation', privateKey: keys.secretKey }) },
          workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never,
            bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
        });
        const start = vi.fn(async () => ({ ok: false as const, errorCode: 'source_stopped', error: 'source_stopped' }));
        const result = await runWithServerHttpBaseUrl('https://bob-home.test', () => coordinate({
          operationId: root.binding.requestId, actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target', stateTransfer: 'transfer' },
          start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
          context: { surface: 'rpc', externalActionExecutionAuthorization: root, requesterSessionBootstrap: requester! },
        })).catch((error: unknown) => {
          if (!custodyOnWire.length) throw error;
          return error;
        });
        if (!custodyOnWire.length) expect(result).toMatchObject({ ok: false, errorCode: 'handoff_target_requires_sandbox_preset' });
        expect(custodyOnWire).toEqual([false]);
        expect(result).toMatchObject({ ok: false, errorCode: 'handoff_target_requires_sandbox_preset' });
        expect(start).not.toHaveBeenCalled();
        return;
      }
      phase = 'read installed Project rows';
      const installedSnapshot = await runWithServerHttpBaseUrl('https://bob-home.test', () => readProjectAccountRows({
        credentials: { token: 'installed-daemon', encryption: null }, serverId: 'bob-home', publication: 'installed' }));
      // The production subscriber and controller consume the real row producer. Only the native sidecar boundary is replaced.
      let finishSidecar!: (result: { type: 'exited'; code: number }) => void;
      const installedRuntime = createDaemonWorkspaceSyncRuntime({ daemonDataRoot: activeServerDir,
        localServerId: 'bob-home', localMachineId: 'source', releaseChannel: 'publicdev',
        resolveWorkspaceRef: id => installedRefs.find(ref => ref.id === id) ?? null,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(activeServerDir, 'installed-locks') }),
        prepareRelationshipTarget: async () => { throw new Error('No local relationship should be prepared'); },
        bootstrap: async () => { throw new Error('No installed workspace should be materialized'); },
        resolveInstalledComponentPaths: () => ({ currentPath: '/fixture', resolvedCurrentPath: '/fixture' }),
        resolveArtifactPaths: () => ({ managerPath: '/fixture/manager', agentPath: '/fixture/agent' }),
        assertArtifactPayload: () => ({ engineVersion: '0.18.1', protocolEpoch: 'external-stream-v1' }),
        createBroker: async () => ({ bootstrapDescriptor: new Uint8Array([1]), waitForReady: async () => undefined,
          command: async command => {
            if (command.t === 'shutdown') finishSidecar({ type: 'exited', code: 0 });
            return command.t === 'list' ? { sessions: [], nextCursor: null } : [];
          }, close: async () => undefined }),
        spawnSidecar: async () => {
          const termination = new Promise<{ type: 'exited'; code: number }>(resolve => { finishSidecar = resolve; });
          return { pid: 42, waitForTermination: () => termination, stop: async () => finishSidecar({ type: 'exited', code: 0 }) };
        },
        launchLocalAgent: async () => { throw new Error('No native agent should launch'); },
      });
      onTestFinished(() => installedRuntime.stop());
      phase = 'start installed WorkspaceSync runtime';
      await installedRuntime.start();
      const beforeRelationships = await installedRuntime.managedWorkspaceSync.listRelationships({ workspaceRefId: installedRefs[0]!.id });
      expect(beforeRelationships.relationships).toMatchObject([{ definition: { relationshipId: relationship.relationshipId } }]);
      if (scenario === 'retired_linked_workspace') retireDuringRead = () => requester!.dispose();
      let publications = 0;
      const release = subscribeActiveProjectAccountRowsSnapshot(() => publications++);
      onTestFinished(release);
      const sync = new WorkspaceSyncController({ adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
        send: async () => { throw new Error('Unexpected native sync'); } }),
        lifecycle: { start: async () => { throw new Error('Unexpected native start'); }, stop: async () => undefined },
        localServerId: 'bob-home', localMachineId: 'source', resolveWorkspaceRef: () => null,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(activeServerDir, 'workspace-locks') }) });
      let statusReads = 0;
      let sourceInstallationId = 'source-installation';
      const callMachine = vi.fn(async (request: Parameters<typeof import('@/session/transport/rpc/machineRpc').callMachineRpc>[0]) => {
        expect(request.externalAction?.context.externalActionExecutionAuthorization).toMatchObject({ token: 'target-child',
          binding: { sessionActionOrigin: root.binding.sessionActionOrigin } });
        expect(request.authorityCeiling).toBe('account_automation');
        if (request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) {
          return { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true };
        }
        expect(typeof request.externalAction?.context.externalActionExecutionAuthorization?.requesterAccountProjection?.sealRequesterAccountContext)
          .toBe('function');
        if (request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3) {
          expect(request.request).toMatchObject({ handoffId: 'handoff-cold', reason: 'target_transport_reached' });
          return { ok: true, status: { handoffId: 'handoff-cold', status: 'aborted',
            phase: 'finalizing', recoveryActions: [] } };
        }
        if (request.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3) {
          expect(request.request).toEqual({ handoffId: 'handoff-cold' });
          if (scenario === 'rotated signer') sourceInstallationId = 'rotated-source-installation';
          if (++statusReads === 1) return { status: { handoffId: 'handoff-cold', status: 'in_progress',
            phase: 'preparing', transportStrategy: 'direct_peer', recoveryActions: [] } };
          return { ok: false, errorCode: 'target_transport_reached', error: 'target_transport_reached' };
        }
        expect(request.request).toMatchObject({ kind: 'requester_session_handoff_bootstrap_v1',
          input: { handoffId: 'handoff-cold', sessionId, sourceMachineId: 'source', targetMachineId: 'target' },
          requesterBootstrap: { credentials: { token: 'bob-ordinary' } } });
        return { ok: false, errorCode: 'not_found', error: 'pending' };
      });
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'bob-home',
        readCredentials: async () => ({ token: 'bob-ordinary', encryption: null }), callMachine,
        wait: async () => {},
        handoffAuthorization: { sourceExportStore: store,
          serverHttpBaseUrl: 'https://bob-home.test', readSourceInstallation: () => ({ machineId: 'source',
            installationId: sourceInstallationId, privateKey: keys.secretKey }) },
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync,
          bootstrap: async () => { throw new Error('Unexpected workspace materialization'); } }),
      });
      phase = 'coordinate requester handoff and workspace membership';
      const outcome = await runWithServerHttpBaseUrl('https://bob-home.test', () => coordinate({ operationId: root.binding.requestId,
        actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target',
          ...(scenario === 'continuation' || continuationRefused ? {} : { workspaceAction: scenario === 'relationship'
            ? { kind: 'relationship', relationshipId: 'requester-relationship', flushBeforeCommit: true } : { kind: 'linked_workspace' } }) },
        context: { surface: 'rpc', externalActionExecutionAuthorization: root, requesterSessionBootstrap: requester! }, signal: new AbortController().signal,
        start: async () => ({ ok: true, result: { handoffId: 'handoff-cold', targetPath: '/target', endpointCandidates: [],
          status: { handoffId: 'handoff-cold', sessionId, sourceMachineId: 'source', targetMachineId: 'target',
            status: 'in_progress', phase: 'preparing', transportStrategy: 'direct_peer', recoveryActions: [] } } }),
        publishOwnerUpdate: () => undefined,
      }));
      if (continuationRefused) expect(outcome).toMatchObject({ ok: false, errorCode: 'target_unavailable',
        failureCause: { phase: 'session.handoff.continuation.custody' } });
      else expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, errorCode: scenario === 'continuation' ? 'target_transport_reached'
        : scenario === 'retired_linked_workspace' ? 'project_requester_authority_unavailable' : 'relationship_source_mismatch' });
      phase = 'settle installed Project subscription after requester handoff';
      await installedRuntime.whenProjectsSettled();
      expect(publications).toBe(0);
      expect(requesterOrganizationBodies).toBe(0);
      expect(getActiveProjectAccountRowsSnapshot()).toBe(installedSnapshot);
      expect(getActiveProjectAccountRowsSnapshot()?.scopeKey).toBe(installedSnapshot.scopeKey);
      expect(await installedRuntime.managedWorkspaceSync.listRelationships({ workspaceRefId: installedRefs[0]!.id })).toEqual(beforeRelationships);
      expect(callMachine.mock.calls.map(([request]) => request.method)).toEqual(scenario === 'continuation'
        ? [RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET, RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
          RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3, RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
          RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3, RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V3]
        : scenario === 'different custody root' ? [RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET]
        : scenario === 'rotated signer' ? [RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET,
          RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3, RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3] : []);
      expect(continuationMints).toBe(scenario === 'continuation' ? 5 : scenario === 'rotated signer' ? 2 : 0);
      // A rejected root remains unbound, including both abort attempts.
      expect(loadCustody).toHaveBeenCalledTimes(scenario === 'different custody root' ? 3
        : scenario === 'continuation' || scenario === 'rotated signer' ? 1 : 0);
      // Prove subscription wiring as well as initial loading: a real installed refresh must change discovery.
      installedRows[installedRows.length - 1] = ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 2,
        content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } });
      phase = 'refresh installed Project subscription';
      await runWithServerHttpBaseUrl('https://bob-home.test', () => readProjectAccountRows({
        credentials: { token: 'installed-daemon', encryption: null }, serverId: 'bob-home',
        selection: { kinds: ['workspace-ref', 'relationship-graph'] } }));
      await installedRuntime.whenProjectsSettled();
      expect(await installedRuntime.managedWorkspaceSync.listRelationships({ workspaceRefId: installedRefs[0]!.id }))
        .toMatchObject({ relationships: [], remoteRelationships: [], membership: { found: false } });
      phase = 'retire fixture requester and installed WorkspaceSync runtime';
    });
  });
  it.each(['relationship', 'linked_workspace'] as const)('reads immutable Home refs concurrently with %s child membership without moving the Session', async kind => {
    await withTempDir('happier-child-session-link-', async root => {
      const home = 'srv_child_session_home';
      const homeUrl = 'https://session-home.example';
      const guestProfileId = 'guest-child-profile';
      const descriptor = { v: 1 as const, homeServerIdentityId: home, canonicalServerUrl: homeUrl, revision: 1,
        endpoints: [{ kind: 'https' as const, url: homeUrl }] };
      const capturedHome = resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
        profile: { id: guestProfileId, serverUrl: homeUrl, webappUrl: homeUrl, homeConnectionDescriptor: descriptor } });
      const observeHome = createCurrentMachineExecutionOriginContextResolver({ serverUrl: homeUrl,
        resolveCurrentMachineId: () => 'child' });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: home } } })));
      onTestFinished(() => { vi.unstubAllGlobals(); });
      const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null };
      const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const relation = { v: 1 as const, relationshipId: 'physical-link', controllerMachineId: 'parent',
        alphaWorkspaceRefId: 'parent-ref', betaWorkspaceRefId: 'target-ref', mode: 'keep_synced' as const,
        contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) }, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
      const refs = [
        { id: 'parent-ref', serverId: home, machineId: 'parent', rootPath: '/host/project', createdAtMs: 1 },
        { id: 'child-ref', serverId: home, machineId: 'child', rootPath: '/work/custom', createdAtMs: 1 },
        { id: 'target-ref', serverId: home, machineId: 'target', rootPath: '/target', createdAtMs: 1 },
      ];
      const managed = ManagedMachineV1Schema.parse({ id: 'retained-child', homeId: home, custodianAccountId: 'owner',
        controller: { machineId: 'parent', installationId: 'parent-installation' },
        launch: { provider: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, name: 'Child', choices: {} },
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'child',
        resource: { contributionRef: { pluginId: 'acme.devcontainer', localId: 'child' }, schemaVersion: 1, value: {},
          devcontainerObservation: { nativeResourceId: 'native-child', user: 'custom-user', workspaceFolder: '/work/custom',
            storage: { kind: 'bind', hostPath: '/host/project', childPath: '/work/custom' } } },
      });
      const projection = deriveManagedDevcontainerChildProjectionV1({ managedMachineId: managed.id,
        controllerMachineId: 'parent', enrolledMachineId: 'child', resource: managed.resource });
      const answerNativeInspect = async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
          || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
          throw new Error('Unexpected controller socket request');
        }
        const content = { mode: 'plain' as const };
        const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
        if (payload.method === `target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`) {
          return { ok: true, result: await socketRpcCodec.encodeResponse(content, transferCapability, decoded.callId) };
        }
        expect(payload.method).toBe('parent:machines.managed.inspect');
        expect(decoded.params).toMatchObject({ homeId: home, managedId: managed.id });
        const inspected = ManagedMachineV1Schema.parse({ ...managed,
          observation: { observedAt: Date.now(), availability: 'present', power: 'running' } });
        return { ok: true, result: await socketRpcCodec.encodeResponse(content, { machine: inspected }, decoded.callId) };
      };
      bindApiSessionSocketMock(socketIo, createApiSessionSocketStub({
        emitWithAck: answerNativeInspect,
        emit: async (event, args) => {
          const response = await answerNativeInspect(event, args[0]);
          if (typeof args[1] !== 'function') throw new Error('Controller socket acknowledgement is missing');
          args[1](response);
        },
      }));
      const graphKey = { kind: 'relationship-graph' as const };
      const rows = [
        ...refs.map(value => { const key = { kind: 'workspace-ref' as const, serverId: home, id: value.id };
          return { key, revision: 1, content: { t: 'plain' as const, v: { key, value } } }; }),
        { key: graphKey, revision: 1, content: { t: 'plain' as const, v: { key: graphKey, value: { relationships: [relation] } } } },
      ];
      const reads: string[] = [];
      const projectReadStarted = Promise.withResolvers<void>();
      const releaseProjectRead = Promise.withResolvers<void>();
      let trackPreflight = false;
      let projectReads = 0;
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        reads.push(path);
        if (path.endsWith('/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v2/sessions/session-child-linked') return { status: 200, data: V2SessionByIdResponseSchema.parse({ session: {
          id: 'session-child-linked', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
          metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), share: null,
          ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1,
            workspace: { machineId: 'child', path: '/work/custom/packages/app' } }),
          agentState: null, agentStateVersion: 1,
        } }) };
        const id = path.slice(path.lastIndexOf('/') + 1);
        if (!['parent', 'child', 'target'].includes(id)) throw new Error('Unexpected Session Home read');
        return { status: 200, data: { machine: { id, active: true, installationId: `${id}-installation`,
          metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          devcontainerChild: id === 'child' ? projection : null,
          metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/custom-user',
            happyHomeDir: '/home/custom-user/.happier', happyCliVersion: 'source-fixture', username: 'custom-user' }) } } };
      });
      const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
        if (String(url).endsWith('/account/project-rows/list')) {
          if (trackPreflight) {
            projectReads++;
            projectReadStarted.resolve();
            await releaseProjectRead.promise;
          }
          return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        }
        if (String(url).endsWith('/machines/managed/actions/get')) return { status: 200, data: managed };
        throw new Error('Unexpected Session Home write');
      });
      onTestFinished(() => { get.mockRestore(); post.mockRestore(); withdrawActiveProjectAccountRowsSnapshot(); });
      // The real target authority consumes the daemon's installed startup
      // projection; this finite handoff read must not establish that scope.
      await runWithServerHttpBaseUrl(homeUrl, () => readProjectAccountRows({ credentials, serverId: home, publication: 'installed' }));
      const resolveRef = (id: string) => refs.find(ref => ref.id === id) ?? null;
      const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') });
      const sync = new WorkspaceSyncController({ localServerId: home, localMachineId: 'child', rootOwnershipManager,
        resolveWorkspaceRef: resolveRef,
        adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: resolveRef,
          send: async () => { throw new Error('Native engine must not be reached before target custody'); } }),
        lifecycle: { start: async () => undefined, stop: async () => undefined },
      });
      onTestFinished(() => sync.shutdown());
      const nativeRequests: unknown[] = [];
      const targetAuthority = createWorkspaceSyncTargetAuthority({ localServerId: home, localMachineId: 'child',
        getProjectSnapshot: getActiveProjectAccountRowsSnapshot,
        callMachineRpc: async request => { nativeRequests.push(request); throw Object.assign(new Error('Target native boundary unavailable'), { code: 'peer_unavailable' }); },
      });
      const workspaceInputs: unknown[] = [];
      const workspaceSyncAdapter = createWorkspaceSyncHandoffAdapter({ sync, bootstrap: async input => {
        workspaceInputs.push(input);
        await targetAuthority.prepareBootstrapAtTarget({ v: 1, bootstrapOperationId: input.operationId,
          owner: { kind: 'relationship', relationshipId: relation.relationshipId }, targetWorkspaceRefId: 'target-ref',
          targetMachineId: 'target', endpointRole: 'beta', policyDigest: relation.contentPolicy.policyDigest,
          createIfMissing: true, ...(input.signal ? { signal: input.signal } : {}) });
        throw new Error('Target native boundary unexpectedly succeeded');
      } });
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: guestProfileId,
        resolveWorkspaceAccountServerId: async signal => {
          const observed = await observeHome(signal);
          return observed ? assertResolvedHomeTargetIdentity(capturedHome, observed.serverIdentityId) : null;
        },
        readCredentials: async () => credentials, workspaceSyncAdapter });
      let stoppedSource = false;
      trackPreflight = true;
      const operation = runWithServerHttpBaseUrl(homeUrl, () => coordinate({
        operationId: 'child-session-operation', actionInput: { sessionId: 'session-child-linked', targetMachineId: 'target',
          accountServerId: home, targetPath: '/target', workspaceAction: kind === 'relationship'
            ? { kind, relationshipId: relation.relationshipId, flushBeforeCommit: true } : { kind } },
        start: async () => { stoppedSource = true; throw new Error('Source must not stop when target bootstrap is unavailable'); },
        signal: new AbortController().signal, publishOwnerUpdate() {},
      }));
      try {
        await Promise.race([projectReadStarted.promise, operation]);
        await vi.waitFor(() => {
          expect(projectReads).toBe(1);
          expect(reads.filter(path => path === '/v1/machines/child' || path === '/v1/machines/target').sort())
            .toEqual(['/v1/machines/child', '/v1/machines/target']);
        });
      } finally {
        releaseProjectRead.resolve();
        await operation;
      }
      expect(await operation).toMatchObject({ ok: false, errorCode: 'peer_unavailable' });
      expect(reads).toEqual(expect.arrayContaining(['/v1/machines/child', '/v1/machines/parent', '/v1/machines/target']));
      expect(workspaceInputs).toEqual([expect.objectContaining({ sourceMachineId: 'child', targetMachineId: 'target',
        sourceWorkspaceRefId: 'child-ref', targetWorkspaceRefId: 'target-ref', sourceRootPath: '/work/custom', targetRootPath: '/target' })]);
      expect(nativeRequests).toEqual([expect.objectContaining({ machineId: 'target', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE })]);
      expect(stoppedSource).toBe(false);
    });
  });

  it('keeps a nested Session directory when an existing all-files relationship is selected', async () => {
    ordinaryMachineHttpBoundary();
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const policy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const flush = vi.fn(async () => ({
      relationshipId: 'source-target', controllerMachineId: 'machine-source', state: 'watching' as const,
      alphaPath: '/source', betaPath: '/target', mode: 'keep_synced' as const,
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0, lastCycleObservedAtMs: null,
    }));
    const workspaceSyncAdapter = createWorkspaceSyncHandoffAdapter({
      sync: { flush } as never,
      relationshipController: { flush },
      bootstrap: async () => ({ release: async () => undefined }),
    });
    const callMachine = vi.fn(async (input: { method: string }) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      return { ok: true };
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveSource: async () => ({
        ok: true, sourceMachineId: 'machine-source',
        sourceRootPath: '/source/packages/app', sessionStorageMode: 'persisted',
      }),
      refreshProjectSnapshot: async () => ({
        source: 'network', loadedAtMs: 1, scopeKey: 'account-1', rows: [], organizations: [], graphRevision: 1,
        workspaceRefs: [
          { id: 'source', serverId: 'server-1', machineId: 'machine-source', rootPath: '/source', createdAtMs: 1 },
          { id: 'target', serverId: 'server-1', machineId: 'machine-target', rootPath: '/target', createdAtMs: 1 },
        ],
        relationships: [{
          v: 1, relationshipId: 'source-target', controllerMachineId: 'machine-source',
          alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'target',
          mode: 'keep_synced', contentPolicy: policy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
        }],
      }),
      workspaceSyncAdapter,
      callMachine,
    });
    const result = await coordinate({
      operationId: 'operation-direct',
      actionInput: {
        sessionId: 'session-1', targetMachineId: 'machine-target', targetPath: '/target',
        workspaceAction: { kind: 'relationship', relationshipId: 'source-target', flushBeforeCommit: true },
      },
      start: async () => ({ ok: true, result: {
        handoffId: 'handoff-direct', targetPath: '/target', endpointCandidates: [],
        status: {
          handoffId: 'handoff-direct', sessionId: 'session-1', sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target', status: 'in_progress', phase: 'preparing',
          transportStrategy: 'server_routed_stream', recoveryActions: [],
        },
      } }),
      signal: new AbortController().signal,
      publishOwnerUpdate: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(callMachine).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      request: expect.objectContaining({ targetPath: '/target/packages/app' }),
    }));
  });
  it('derives a linked spoke route from the admitted nested Session and keeps the target subdirectory', async () => {
    ordinaryMachineHttpBoundary();
    const basePolicy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const sourcePolicy = { ...basePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(basePolicy) };
    const targetBasePolicy = { ...basePolicy, selection: 'all_files' as const };
    const targetPolicy = { ...targetBasePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(targetBasePolicy) };
    const workspaceSyncAdapter = {
      prepareBetween: vi.fn(async () => { throw new Error('Unexpected workspace route preparation'); }),
      prepare: vi.fn(async (input: { operationId: string }) => ({ kind: 'linked_workspace' as const, operationId: input.operationId, action: { kind: 'linked_workspace' as const } })),
      finalize: vi.fn(), commit: vi.fn(), abort: vi.fn(async () => undefined),
    };
    const callMachine = vi.fn(async (input: MachineCallInput) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      return { ok: true };
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveSource: async () => ({ ok: true, sourceMachineId: 'machine-c', sourceRootPath: '/source/packages/app', sessionStorageMode: 'persisted' }),
      refreshProjectSnapshot: async () => ({
        source: 'network', loadedAtMs: 1, scopeKey: 'account-1', rows: [], organizations: [], graphRevision: 1,
        workspaceRefs: [
          { id: 'hub', serverId: 'server-1', machineId: 'machine-a', rootPath: '/hub', createdAtMs: 1 },
          { id: 'source', serverId: 'server-1', machineId: 'machine-c', rootPath: '/source', createdAtMs: 1 },
          { id: 'target', serverId: 'server-1', machineId: 'machine-b', rootPath: '/target', createdAtMs: 1 },
        ],
        relationships: [
          { v: 1, relationshipId: 'a-c', controllerMachineId: 'machine-a', alphaWorkspaceRefId: 'hub', betaWorkspaceRefId: 'source', mode: 'keep_both_in_sync', contentPolicy: sourcePolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
          { v: 1, relationshipId: 'a-b', controllerMachineId: 'machine-a', alphaWorkspaceRefId: 'hub', betaWorkspaceRefId: 'target', mode: 'keep_synced', contentPolicy: targetPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
        ],
      }),
      resolveWorkspaceTransferRoot: async () => ({ repositoryRoot: '/source', sessionRelativeCwd: 'packages/app' }),
      workspaceSyncAdapter,
      callMachine,
    });
    const result = await coordinate({
      operationId: 'operation-linked',
      actionInput: { sessionId: 'session-1', targetMachineId: 'machine-b', targetPath: '/target', workspaceAction: { kind: 'linked_workspace' } },
      start: async () => ({ ok: true, result: {
        handoffId: 'handoff-linked', targetPath: '/target', endpointCandidates: [],
        status: { handoffId: 'handoff-linked', sessionId: 'session-1', sourceMachineId: 'machine-c', targetMachineId: 'machine-b', status: 'in_progress', phase: 'preparing', transportStrategy: 'server_routed_stream', recoveryActions: [] },
      } }),
      signal: new AbortController().signal,
      publishOwnerUpdate: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(workspaceSyncAdapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      action: { kind: 'linked_workspace' }, sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target',
      sourceRootPath: '/source', targetRootPath: '/target',
    }));
    expect(callMachine).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
      request: expect.objectContaining({ targetPath: '/target/packages/app', workspaceRootPath: '/target', workspaceSessionRelativeCwd: 'packages/app' }),
    }));
  });

  it('fails closed when a current V3 prepare response omits its qualified Agent target', () => {
    expect(() => buildTrackedSessionHandoffSpawnOptions({
      targetMachineId: 'target-1',
      prepared: {
        handoffId: 'handoff-1',
        status: {} as never,
        resume: {
          directory: '/target/workspace',
          agent: 'codex',
          resume: 'remote-1',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      } as never,
    })).toThrow();
  });

  it('uses the qualified current Agent target and descriptor for current handoff writes', () => {
    const options = buildTrackedSessionHandoffSpawnOptions({
      targetMachineId: 'target-1',
      prepared: {
        handoffId: 'handoff-current',
        status: {} as never,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'acme.agent',
          agent: {
            runtime: 'native',
            futureResumeCritical: { opaque: 'preserve-me' },
          },
        },
        resume: {
          directory: '/target/workspace',
          agent: 'acme.agent',
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'acme.plugin', localId: 'agent' },
          },
          resume: 'remote-1',
          transcriptStorage: 'persisted',
          approvedNewDirectoryCreation: true,
        },
      },
    });

    expect(options.agentTarget).toEqual({
      kind: 'agent',
      identity: { pluginId: 'acme.plugin', localId: 'agent' },
    });
    expect(options.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'acme.agent',
      agent: {
        runtime: 'native',
        futureResumeCritical: { opaque: 'preserve-me' },
      },
    });
    expect(options).not.toHaveProperty('backendTarget');
  });

  it('admits copy without a replacement approval and returns the typed update requirement for an older target daemon', async () => {
    const policyInput = {
      v: 1 as const,
      selection: 'all_files' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const action = {
      kind: 'copy_once' as const,
      contentPolicy: {
        ...policyInput,
        policyDigest: computeWorkspaceSyncPolicyDigest(policyInput),
      },
    };
    const prepared = { kind: 'copy_once' as const, operationId: 'operation-1', action };
    const workspaceSyncAdapter = {
      prepareBetween: vi.fn(async () => { throw new Error('Unexpected workspace route preparation'); }),
      prepare: vi.fn(async () => prepared),
      finalize: vi.fn(async () => prepared),
      commit: vi.fn(async () => prepared),
      abort: vi.fn(async () => undefined),
    };
    const callMachine = vi.fn(async (input: MachineCallInput) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
      throw Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      });
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveSource: async () => ({
        ok: true,
        sourceMachineId: 'source-1',
        sourceRootPath: '/source/workspace',
        sessionStorageMode: 'persisted',
      }),
      callMachine,
      workspaceSyncAdapter,
    });

    await expect(coordinate({
      operationId: 'operation-1',
      actionInput: {
        sessionId: 'session-1',
        targetMachineId: 'target-1',
        targetPath: '/target/workspace',
        accountServerId: 'server-1',
        workspaceAction: action,
      },
      start: async () => ({
        ok: true,
        result: {
          handoffId: 'handoff-1',
          targetPath: '/target/workspace',
          endpointCandidates: [],
          status: {
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            sourceMachineId: 'source-1',
            targetMachineId: 'target-1',
            status: 'in_progress',
            phase: 'preparing',
            transportStrategy: 'server_routed_stream',
            recoveryActions: [],
          },
        },
      }),
      signal: new AbortController().signal,
      publishOwnerUpdate: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'workspace_sync_update_required',
    });
    // An older TARGET has no workspace capture; its copy keeps today's placement.
    expect(callMachine).toHaveBeenCalledTimes(5);
    expect(callMachine).toHaveBeenNthCalledWith(2, expect.objectContaining({
      machineId: 'target-1',
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3,
    }));
    expect(callMachine).toHaveBeenNthCalledWith(3, expect.objectContaining({
      machineId: 'target-1',
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
    }));
  });

  it.each(['member', 'machine_manage_required', 'workspace_private_checkout_review_required'] as const)('consumes the TARGET workspace capture decision before any workspace effect (%s)', async decision => {
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const action = { kind: 'copy_once' as const,
      contentPolicy: { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) } };
    const prepared = { kind: 'copy_once' as const, operationId: 'operation-1', action };
    const workspaceSyncAdapter = {
      prepareBetween: vi.fn(async () => { throw new Error('Unexpected workspace route preparation'); }),
      prepare: vi.fn(async () => prepared),
      finalize: vi.fn(async () => prepared),
      commit: vi.fn(async () => prepared),
      abort: vi.fn(async () => undefined),
    };
    const reviewedFolder = { accountId: 'member-a', serverId: 'server-1', machineId: 'target-1',
      destinationParentPath: '/members/member-a', destinationDirectoryName: 'workspace' };
    const reviewCause = { phase: 'session.handoff.workspace_capture', errorClass: 'Error',
      errorCode: 'workspace_private_checkout_review_required', httpStatus: null,
      nativeErrorReason: 'workspace_private_checkout_review_required' };
    const captures: unknown[] = [];
    // The TARGET daemon is the network boundary; the coordinator, transport
    // wrapping and the workspace input it builds stay real.
    const callMachine = vi.fn(async (input: MachineCallInput) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3) {
        const request = input.request as { input: { release?: true } };
        captures.push(request.input);
        if (request.input.release) return { ok: true, capture: 'released' };
        if (decision === 'workspace_private_checkout_review_required') {
          return { ok: false, errorCode: decision, failureCause: reviewCause,
            details: { kind: 'refused', code: decision, failureCause: reviewCause, destinationReview: reviewedFolder } };
        }
        return decision === 'member'
          ? { ok: true, capture: 'member', sourceWorkspaceRefId: 'source-ref',
            targetRootPath: '/members/member-a/workspace', targetWorkspaceRefId: 'workspace' }
          : { ok: false, errorCode: 'machine_manage_required', error: 'Writing outside your own folder needs Manage access to this Machine' };
      }
      throw Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    });
    const start = vi.fn(async () => ({ ok: true as const, result: { handoffId: 'handoff-1', targetPath: '/members/member-a/workspace',
      endpointCandidates: [], status: { handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
        targetMachineId: 'target-1', status: 'in_progress', phase: 'preparing', transportStrategy: 'server_routed_stream',
        recoveryActions: [] } } }));
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveSource: async () => ({ ok: true, sourceMachineId: 'source-1', sourceRootPath: '/source/workspace', sessionStorageMode: 'persisted' }),
      callMachine,
      workspaceSyncAdapter,
    });

    const result = await coordinate({ operationId: 'operation-1', actionInput: { sessionId: 'session-1', targetMachineId: 'target-1',
      targetPath: '/members/member-a/workspace', accountServerId: 'server-1', workspaceAction: action },
      start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn() });

    expect(captures[0]).toMatchObject({ sessionId: 'session-1', sourceMachineId: 'source-1', targetMachineId: 'target-1',
      operationId: 'operation-1', accountServerId: 'server-1', sourceRootPath: '/source/workspace',
      targetPath: '/members/member-a/workspace', workspaceAction: action });
    if (decision !== 'member') {
      expect(result).toMatchObject(decision === 'workspace_private_checkout_review_required'
        ? { ok: false, errorCode: decision, failureCause: reviewCause,
          details: { kind: 'refused', code: decision, failureCause: reviewCause, destinationReview: reviewedFolder } }
        : { ok: false, errorCode: decision });
      expect(workspaceSyncAdapter.prepare).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(captures).toHaveLength(1);
      return;
    }
    expect(workspaceSyncAdapter.prepare).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'operation-1',
      sourceWorkspaceRefId: 'source-ref', targetWorkspaceRefId: 'workspace', targetRootPath: '/members/member-a/workspace' }));
    // The SOURCE's terminal state releases this operation's capture, here after a failed target prepare.
    expect(result).toMatchObject({ ok: false, errorCode: 'workspace_sync_update_required' });
    expect(captures.at(-1)).toMatchObject({ operationId: 'operation-1', release: true });
    expect(captures).toHaveLength(2);
  });

  // HANDOFF-SYNC-CHILD-1124: workspace preparation observes the other endpoint with the admitted requester's
  // custody, so the coordinator hands it that admitted context; without a requester the call is unchanged.
  it.each(['admitted requester', 'no requester'] as const)('hands workspace preparation the admitted requester context (%s)', async scenario => {
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const action = { kind: 'copy_once' as const,
      contentPolicy: { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) } };
    const prepare = vi.fn(async (_input: unknown, _authority?: unknown, _context?: unknown) => {
      throw Object.assign(new Error('Workspace preparation reached'), { code: 'workspace_preparation_reached' });
    });
    const workspaceSyncAdapter = { prepareBetween: vi.fn(), prepare, finalize: vi.fn(), commit: vi.fn(), abort: vi.fn(async () => undefined) };
    const callMachine = vi.fn(async (input: MachineCallInput) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3) {
        const request = input.request as { input: { release?: true } };
        return request.input.release ? { ok: true, capture: 'released' } : { ok: true, capture: 'member',
          sourceWorkspaceRefId: 'source-ref', targetRootPath: '/members/member-a/workspace', targetWorkspaceRefId: 'workspace' };
      }
      throw Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    });
    // The ingress-admitted requester (a person with Manage on this SOURCE): its owner is the requester bootstrap.
    const machineAdmission = { actorAccountId: 'member-a', custodianAccountId: 'owner', machineId: 'source-1',
      installationId: 'source-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const requester = { credentials: { token: 'member-a-token', encryption: null }, serverHttpBaseUrl: 'https://home.test',
      attribution: { serverId: 'server-1', accountId: 'member-a', machineId: 'source-1', installationId: 'source-installation' },
      getBoundSessionId: () => 'session-1', isCurrent: async () => true } as unknown as AdmittedRequesterSessionBootstrap;
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveSource: async () => ({ ok: true, sourceMachineId: 'source-1', sourceRootPath: '/source/workspace', sessionStorageMode: 'persisted' }),
      callMachine,
      workspaceSyncAdapter,
    });
    const result = await coordinate({ operationId: 'operation-1', actionInput: { sessionId: 'session-1', targetMachineId: 'target-1',
      targetPath: '/members/member-a/workspace', accountServerId: 'server-1', workspaceAction: action },
      start: vi.fn(), signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
      ...(scenario === 'admitted requester' ? { context: { surface: 'rpc' as const, requesterSessionBootstrap: requester, machineAdmission } } : {}) });
    expect(result).toMatchObject({ ok: false, errorCode: 'workspace_preparation_reached' });
    expect(prepare).toHaveBeenCalledTimes(1);
    if (scenario === 'no requester') {
      expect(prepare.mock.calls[0]).toHaveLength(1);
      return;
    }
    expect(prepare.mock.calls[0]).toEqual([expect.objectContaining({ operationId: 'operation-1' }), undefined,
      expect.objectContaining({ requesterSessionBootstrap: requester, machineAdmission })]);
  });

  it('routes the accepted handoff through the existing source and target daemon primitives', async () => {
    const calls: Array<Pick<MachineCallInput, 'machineId' | 'method' | 'request' | 'timeoutMs'>> = [];
    let statusGets = 0;
    const callMachine = vi.fn(async (input: MachineCallInput) => {
      calls.push(input);
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
      // This TARGET is the requester's own: the workspace copy keeps native placement.
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3) return { ok: true, capture: 'not_required' };
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) {
        return { ok: false, errorCode: 'not_found', error: 'pending' };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3) {
        return {
          handoffId: 'handoff-1',
          status: {
            handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
            targetMachineId: 'target-1', status: 'ready_for_cutover', phase: 'staging_target',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
          remoteSessionId: 'remote-1',
          directSource: { kind: 'claudeConfig', configDir: null, projectId: null },
          resume: {
            directory: '/target/workspace', agent: 'claude',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            resume: 'remote-1',
            transcriptStorage: 'persisted', approvedNewDirectoryCreation: true,
          },
        };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3) {
        statusGets++;
        return {
          handoffId: 'handoff-1',
          transitionRevision: 3,
          status: {
            handoffId: 'handoff-1', status: statusGets === 1 ? 'in_progress' : 'ready_for_cutover', phase: 'staging_target',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
        };
      }
      if (input.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        return { type: 'success', spawnNonce: 'handoff:handoff-1', sessionIdStatus: 'pending' };
      }
      if (input.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE) {
        return { status: 'success', sessionId: 'session-1' };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3) {
        if (input.machineId === 'source-1') {
          return { ok: false, errorCode: 'source_cleanup_busy', error: 'Source cleanup is still pending.' };
        }
        return {
          handoffId: 'handoff-1',
          status: {
            handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
            targetMachineId: 'target-1', status: 'completed', phase: 'finalizing',
            transportStrategy: 'server_routed_stream', recoveryActions: [],
          },
        };
      }
      return { ok: true };
    });
    const policyInput = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const contentPolicy = {
      ...policyInput,
      policyDigest: computeWorkspaceSyncPolicyDigest(policyInput),
    };
    const approval = {
      v: 1 as const,
      consequences: [
        'replace_nonempty_workspace_target',
        'delete_target_only_files_during_exact_mirror',
      ] as const,
      serverId: 'server-1',
      machineId: 'target-1',
      canonicalRoot: '/target/workspace',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'action-request-1',
    };
    const relationshipStatus: WorkspaceSyncStatusV1 = {
      relationshipId: 'relationship-1',
      controllerMachineId: 'source-1',
      state: 'watching',
      alphaPath: '/source/workspace',
      betaPath: '/target/workspace',
      mode: 'mirror_exactly',
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0,
      lastCycleObservedAtMs: 1,
    };
    const sync: ManagedWorkspaceSync = {
      resolveLocalResolutionEndpoint: vi.fn(async () => null),
      borrowSourceRootForCopy: vi.fn(async () => null),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      subscribe: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })),
      ensure: vi.fn(async () => relationshipStatus),
      copyOnce: vi.fn(async () => relationshipStatus),
      flush: vi.fn(async () => relationshipStatus),
      pause: vi.fn(async () => ({ ...relationshipStatus, state: 'paused' as const })),
      resume: vi.fn(async () => relationshipStatus),
      terminate: vi.fn(async () => undefined),
      listConflicts: vi.fn(async () => ({
        status: 'page' as const,
        relationshipId: 'relationship-1',
        totalCount: 0,
        nextCursor: null,
        conflicts: [],
      })),
      listRelationships: vi.fn(async () => { throw new Error('unexpected relationship inspection'); }),
      watchStatuses: vi.fn(async () => { throw new Error('unexpected status watch'); }),
      inspectConflict: vi.fn(async () => { throw new Error('unexpected conflict inspection'); }),
      resolveConflict: vi.fn(async () => { throw new Error('unexpected conflict resolution'); }),
      readFile: vi.fn(async () => ({ status: 'missing' as const })),
      withAuthorizedSourceSeedExport: vi.fn(async (_request, exportSource) => await exportSource('/source/workspace')),
      withSourceSeedAuthorization: vi.fn(async (_operation, _handles, action) => await action()),
    } satisfies ManagedWorkspaceSync;
    const relationship = {
      v: 1 as const,
      relationshipId: 'relationship-1',
      controllerMachineId: 'source-1',
      alphaWorkspaceRefId: 'source-ref',
      betaWorkspaceRefId: 'target-ref',
      mode: 'mirror_exactly' as const,
      contentPolicy,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const prepareCreate = vi.fn(async () => ({
      relationship,
      status: relationshipStatus,
      reused: false as const,
      commit: vi.fn(async () => relationship),
      abort: vi.fn(async () => undefined),
    }));
    const workspaceSyncAdapter = createWorkspaceSyncHandoffAdapter({
      sync,
      relationshipOwner: { materializeEndpoints: vi.fn(), prepareCreate },
      bootstrap: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
    });
    const refreshProjectSnapshot = vi.fn(async () => ({
      source: 'network' as const, loadedAtMs: 1, scopeKey: 'account-1', rows: [], organizations: [], graphRevision: 8,

      workspaceRefs: [
        { id: 'source-ref', serverId: 'server-1', machineId: 'source-1', rootPath: '/source/workspace', createdAtMs: 1 },
        { id: 'target-ref', serverId: 'server-1', machineId: 'target-1', rootPath: '/target/workspace', createdAtMs: 1 },
      ],
      relationships: [],
    }));
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveSource: async () => ({
        ok: true,
        sourceMachineId: 'source-1',
        sourceRootPath: '/source/workspace/packages/app',
        sessionStorageMode: 'persisted',
      }),
      callMachine,
      wait: async () => undefined,
      workspaceSyncAdapter,
      refreshProjectSnapshot,
      resolveWorkspaceTransferRoot: async () => ({
        repositoryRoot: '/source/workspace',
        sessionRelativeCwd: 'packages/app',
      }),
    });

    let privateStartInput: unknown;
    const result = await coordinate({
      operationId: 'action-request-1',
      actionInput: {
        sessionId: 'session-1',
        targetMachineId: 'target-1',
        targetPath: '/target/workspace',
        accountServerId: 'server-1',
        actionRequestId: 'action-request-1',
        handoffTargetReplacementApproval: approval,
        handoffTargetReplacementApprovalReceiptId: 'approval-receipt-1',
        handoffTargetReplacementApprovalActionInput: {
          sessionId: 'session-1', targetMachineId: 'target-1', targetPath: '/target/workspace',
        },
        workspaceAction: {
          kind: 'create_relationship',
          mode: 'mirror_exactly',
          contentPolicy,
          flushBeforeCommit: true,
        },
      },
      start: async (input?: unknown) => {
        privateStartInput = input;
        return {
          ok: true as const,
          result: {
            handoffId: 'handoff-1', targetPath: '/source/workspace', endpointCandidates: [],
            status: {
              handoffId: 'handoff-1', sessionId: 'session-1', sourceMachineId: 'source-1',
              targetMachineId: 'target-1', status: 'in_progress', phase: 'preparing',
              transportStrategy: 'server_routed_stream', recoveryActions: [],
            },
          },
        };
      },
      signal: new AbortController().signal,
      publishOwnerUpdate: vi.fn(),
    });

    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.result).toMatchObject({
      handoffId: 'handoff-1',
      workspace: {
        kind: 'relationship',
        relationshipId: 'relationship-1',
        created: true,
      },
      warning: {
        code: 'source_cleanup_failed',
        message: 'Source cleanup is still pending.',
      },
    });
    expect(privateStartInput).toMatchObject({
      sessionId: 'session-1',
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      sessionStorageMode: 'persisted',
      preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
      ...(receiptId ? { handoffTargetReplacementApprovalReceiptId: receiptId } : {}),
    });
    expect(calls.map(({ machineId, method }) => [machineId, method])).toEqual([
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3],
      ['target-1', RPC_METHODS.SPAWN_HAPPY_SESSION],
      ['target-1', RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3],
      ['source-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3],
    ]);
    expect((calls[6]!.request as { sessionId?: string }).sessionId).toBe('session-1');
    expect(calls[2]!.request).toEqual(expect.objectContaining({
      targetPath: '/target/workspace/packages/app',
      workspaceRootPath: '/target/workspace',
      workspaceSessionRelativeCwd: 'packages/app',
    }));
    expect(calls[6]!.timeoutMs).toBe(5 * 60_000);
    expect(refreshProjectSnapshot).not.toHaveBeenCalled();
    expect(prepareCreate).toHaveBeenCalledTimes(1);
    expect(prepareCreate).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'action-request-1',
      serverId: 'server-1',
      sourceRootPath: '/source/workspace',
      targetRootPath: '/target/workspace',
      targetReplacementApproval: approval,
      targetReplacementApprovalReceiptId: 'approval-receipt-1',
      targetReplacementApprovalActionInput: {
        sessionId: 'session-1', targetMachineId: 'target-1', targetPath: '/target/workspace',
      },
    }));
  });

  it('forwards present_user authority, Agent sessionActionOrigin, PAT callerInputConstraints, and permission ceilings into workspaceSyncContext for H02 handoffs', async () => {
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const action = { kind: 'copy_once' as const,
      contentPolicy: { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) } };
    const machineAdmission = { actorAccountId: 'guest-b', custodianAccountId: 'owner-a', machineId: 'source-1',
      installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const keys = nacl.sign.keyPair();
    const requester = { credentials: { token: 'guest-b-token', encryption: null }, serverHttpBaseUrl: 'https://home.test',
      attribution: { serverId: 'server-1', accountId: 'guest-b', machineId: 'source-1', installationId: 'source-installation' },
      getBoundSessionId: () => 'session-1', isCurrent: async () => true,
      projectExternalActionAuthorization: async <T>(authorization: T) => authorization } as unknown as AdmittedRequesterSessionBootstrap;
    const handoffRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'handoff-root-token', binding: {
      accountId: 'guest-b', custodianAccountId: 'owner-a', admittedMachineRole: 'use',
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'server-1', machineId: 'source-1', installationId: 'source-installation',
      actionId: 'session.handoff', requestId: 'operation-1', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'source-1' },
      handoffAdmission: { sessionId: 'session-1', sourceMachineId: 'source-1', sourceInstallationId: 'source-installation',
        targetMachineId: 'target-1', targetInstallationId: 'target-installation' },
    } });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { status: 200, data: { v: 1, token: 'target-preflight-child', binding: { ...handoffRoot.binding,
        machineId: 'target-1', custodianAccountId: 'guest-b', installationId: 'target-installation', target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        handoffPreflight: { rootRequestId: handoffRoot.binding.requestId, rootRequestEnvelopeDigest: handoffRoot.binding.requestEnvelopeDigest },
      } } };
    });
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const };
    const sessionActionOrigin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'agent-session', starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'turn-1', requestId: 'req-agent', callerPermissionMode: 'read-only' as const,
      causalPermissionAuthority, workspaceWrites: 'deny' as const };
    const callerInputConstraints = { models: null, permissionModes: ['default'] as const };

    const captureContext = async (contextOverrides: Record<string, unknown>) => {
      let receivedContext: RpcHandlerContext | undefined;
      const prepare = vi.fn(async (_input: unknown, _authority?: unknown, context?: RpcHandlerContext) => {
        receivedContext = context;
        throw Object.assign(new Error('Workspace preparation reached'), { code: 'workspace_preparation_reached' });
      });
      const coordinate = createTrackedSessionHandoffCoordinator({
        expectedAccountServerId: 'server-1',
        readCredentials: async () => ({ token: 'owner-a-token', encryption: null }),
        resolveSource: async () => ({ ok: true, sourceMachineId: 'source-1', sourceRootPath: '/source/workspace', sessionStorageMode: 'persisted' }),
        handoffAuthorization: {
          sourceExportStore: { load: async () => null } as never,
          serverHttpBaseUrl: 'https://home.test',
          readSourceInstallation: () => ({ machineId: 'source-1', installationId: 'source-installation', privateKey: keys.secretKey }),
        },
        callMachine: vi.fn(async (input: MachineCallInput) => {
          if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return transferCapability;
          if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3) return { ok: true, capture: 'not_required' };
          throw Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        }),
        workspaceSyncAdapter: { prepareBetween: vi.fn(), prepare, finalize: vi.fn(), commit: vi.fn(), abort: vi.fn(async () => undefined) },
      });
      const result = await coordinate({
        operationId: 'operation-1',
        actionInput: { sessionId: 'session-1', targetMachineId: 'target-1', targetPath: '/target/workspace',
          accountServerId: 'server-1', workspaceAction: action },
        start: vi.fn(), signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
        context: {
          surface: 'rpc' as const,
          requesterSessionBootstrap: requester,
          machineAdmission,
          externalActionExecutionAuthorization: handoffRoot,
          verifyMachineAdmissionCurrent: async () => true,
          ...contextOverrides,
        } as never,
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'workspace_preparation_reached' });
      expect(receivedContext).toBeDefined();
      return {
        raw: receivedContext!,
        projected: projectWorkspaceSyncPhysicalContextFromActionContext(buildActionExecutorContextForRpc(receivedContext!)),
      };
    };

    // 1. Present-user H02 handoff preserves present_user (never downgraded to account_automation) plus permission ceilings.
    const presentUser = await captureContext({
      authority: 'present_user' as const,
      callerPermissionMode: 'default' as const,
      causalPermissionAuthority,
      workspaceWrites: 'allow' as const,
    });
    expect(presentUser.raw.callerAuthority).toBe('present_user');
    expect(presentUser.projected).toMatchObject({
      callerAuthority: 'present_user',
      callerPermissionMode: 'default',
      causalPermissionAuthority,
      workspaceWrites: 'allow',
    });

    // 2. Agent-origin H02 handoff preserves sessionActionOrigin and its permission/write ceilings.
    const agentOrigin = await captureContext({
      authority: 'account_automation' as const,
      sessionActionOrigin,
    });
    expect(agentOrigin.raw.sessionActionOrigin).toEqual(sessionActionOrigin);
    expect(agentOrigin.projected).toMatchObject({
      callerAuthority: 'account_automation',
      sessionActionOrigin,
      callerPermissionMode: 'read-only',
      causalPermissionAuthority,
      workspaceWrites: 'deny',
    });

    // 3. PAT-origin H02 handoff preserves callerInputConstraints and account_automation authority.
    const patOrigin = await captureContext({
      authority: 'account_automation' as const,
      callerInputConstraints,
    });
    expect(patOrigin.raw.callerInputConstraints).toEqual(callerInputConstraints);
    expect(patOrigin.projected).toMatchObject({
      callerAuthority: 'account_automation',
      callerInputConstraints,
    });
  });
});
