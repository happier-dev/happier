import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios from 'axios';
import { join } from 'node:path';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { withTempDir } from '@/testkit/fs/tempDir';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createApiSessionSocketStub, bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import nacl from 'tweetnacl';
import { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
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

describe('createTrackedSessionHandoffCoordinator', () => {
  it.each(['existing_session_state_unavailable', 'handoff_existing_state_update_required'])('refuses %s before stopping the source through the target preflight transport', async errorCode => {
    const sessionId = `c${'d'.repeat(24)}`;
    handoffSourceHttpBoundary(sessionId);
    const callMachine = vi.fn(async (input: { method: string }) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) return { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true };
      if (errorCode === 'handoff_existing_state_update_required') throw Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
      return { ok: false, errorCode };
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1', readCredentials: async () => ({ token: 'token' }), callMachine,
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
      readCredentials: async () => ({ token: 'token' }), callMachine,
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

  it('preflights an accepted root without source-export custody and preserves its requester authority', async () => {
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
      const callMachine = vi.fn(async (input: Parameters<NonNullable<Parameters<typeof createTrackedSessionHandoffCoordinator>[0]['callMachine']>>[0]) => {
        expect(input.externalAction?.effectActionId).toBe('session.handoff');
        expect(input.externalAction?.context.externalActionExecutionAuthorization?.binding.handoffPreflight).toEqual({
          rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest,
        });
        if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET) {
          return { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true };
        }
        expect(input.request).toMatchObject({ kind: 'requester_session_handoff_preflight_bootstrap_v1',
          input: { sessionId, sourceMachineId: 'source', targetMachineId: 'target' },
          requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: 'requester-token' } },
        });
        return { ok: false, errorCode: 'existing_session_state_unavailable' };
      });
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'server-1',
        readCredentials: async () => ({ token: 'requester-token' }), callMachine,
        handoffAuthorization: { sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
          serverHttpBaseUrl: 'http://requester-home.invalid', readSourceInstallation: () => ({
            machineId: 'source', installationId: 'source-installation', privateKey: keys.secretKey,
          }) },
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync: {} as never, bootstrap: async () => { throw new Error('Unexpected workspace bootstrap'); } }),
      });
      const start = vi.fn(async () => ({ ok: false as const, errorCode: 'source_stopped', error: 'source_stopped' }));
      expect(await coordinate({ operationId: 'original-request',
        actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target', stateTransfer: 'existing' },
        start, signal: new AbortController().signal, publishOwnerUpdate: vi.fn(),
        context: { externalActionExecutionAuthorization: root },
      })).toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
      expect(start).not.toHaveBeenCalled();
      expect(callMachine).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3 }));
    });
  });

  it('continues the same requester handoff from cold protected root custody after its source stops', async () => {
    await withTempDir('handoff-requester-continuation-', async activeServerDir => {
      const sessionId = `c${'b'.repeat(24)}`;
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'accepted-original-root', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_bob',
        machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation', actionId: 'session.handoff',
        requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId, starterDepth: 1, turnDepth: 2 },
          callerPermissionMode: 'default', sourceTurnId: 'original-turn', requestId: 'original-request' },
        sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
        handoffAdmission: { sessionId, sourceMachineId: 'source', targetMachineId: 'target',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } });
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      await store.save({ handoffId: 'handoff-cold', sessionId, sourceMachineId: 'source', targetMachineId: 'target',
        exportedAtMs: 1, acceptedHandoffAuthorization: root });
      // Only Home HTTP and the target Machine transport are substituted.
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'bob' } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
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
      vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
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
        expect(request.handoffContinuation).toEqual({ authorization: root, handoffId: 'handoff-cold' });
        return { status: 200, data: { v: 1, token: 'target-child', binding: { ...root.binding,
          machineId: 'target', installationId: 'target-installation', target: request.envelope.target,
          actionId: 'session.handoff.prepare_target', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
          handoffContinuation: { rootRequestId: root.binding.requestId,
            rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest, handoffId: 'handoff-cold' },
        } } };
      });
      const credentialBinding = { happyHomeDir: activeServerDir, sessionId,
        attribution: { serverId: 'bob-home', accountId: 'bob', machineId: 'source', installationId: 'source-installation' } };
      await createRequesterSessionCredentialCustody({ ...credentialBinding, credentials: { token: 'bob-ordinary', encryption: null } });
      const requester = await resolveRequesterSessionBootstrap({ ...credentialBinding, serverHttpBaseUrl: 'https://bob-home.test',
        machineAdmissionBoundary: { machineId: 'source', daemonToken: 'alice-daemon', isHomeCurrent: () => true,
          readInstallation: () => ({ installationId: 'source-installation', privateKey: keys.secretKey }) } });
      expect(requester).not.toBeNull();
      const sync = new WorkspaceSyncController({ adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: () => null,
        send: async () => { throw new Error('Unexpected native sync'); } }),
        lifecycle: { start: async () => { throw new Error('Unexpected native start'); }, stop: async () => undefined },
        localServerId: 'bob-home', localMachineId: 'source', resolveWorkspaceRef: () => null,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(activeServerDir, 'workspace-locks') }) });
      const callMachine = vi.fn(async (request: Parameters<typeof import('@/session/transport/rpc/machineRpc').callMachineRpc>[0]) => {
        expect(request.externalAction?.context.externalActionExecutionAuthorization).toMatchObject({ token: 'target-child',
          binding: { sessionActionOrigin: root.binding.sessionActionOrigin } });
        expect(typeof request.externalAction?.context.externalActionExecutionAuthorization?.requesterAccountProjection?.sealRequesterAccountContext)
          .toBe('function');
        expect(request.authorityCeiling).toBe('account_automation');
        expect(request.request).toMatchObject({ kind: 'requester_session_handoff_bootstrap_v1',
          input: { handoffId: 'handoff-cold', sessionId, sourceMachineId: 'source', targetMachineId: 'target' },
          requesterBootstrap: { credentials: { token: 'bob-ordinary' } } });
        return { ok: false, errorCode: 'target_transport_reached', error: 'target_transport_reached' };
      });
      const coordinate = createTrackedSessionHandoffCoordinator({ expectedAccountServerId: 'bob-home',
        readCredentials: async () => ({ token: 'bob-ordinary', encryption: null }), callMachine,
        handoffAuthorization: { sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir }),
          serverHttpBaseUrl: 'https://bob-home.test', readSourceInstallation: () => ({ machineId: 'source',
            installationId: 'source-installation', privateKey: keys.secretKey }) },
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync,
          bootstrap: async () => { throw new Error('Unexpected workspace materialization'); } }),
      });
      expect(await runWithServerHttpBaseUrl('https://bob-home.test', () => coordinate({ operationId: root.binding.requestId,
        actionInput: { sessionId, targetMachineId: 'target', targetPath: '/target' },
        context: { surface: 'rpc', externalActionExecutionAuthorization: root, requesterSessionBootstrap: requester! }, signal: new AbortController().signal,
        start: async () => ({ ok: true, result: { handoffId: 'handoff-cold', targetPath: '/target', endpointCandidates: [],
          status: { handoffId: 'handoff-cold', sessionId, sourceMachineId: 'source', targetMachineId: 'target',
            status: 'in_progress', phase: 'preparing', transportStrategy: 'direct_peer', recoveryActions: [] } } }),
        publishOwnerUpdate: () => undefined,
      }))).toMatchObject({ ok: false, errorCode: 'target_transport_reached' });
      expect(callMachine).toHaveBeenCalledTimes(1);
    });
  });
  it.each(['relationship', 'linked_workspace'] as const)('uses immutable Home refs independently of the guest profile before %s child membership without moving the Session', async kind => {
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
      onTestFinished(() => vi.unstubAllGlobals());
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
        expect(payload.method).toBe('parent:machines.managed.inspect');
        const content = { mode: 'plain' as const };
        const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
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
        if (String(url).endsWith('/account/project-rows/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        if (String(url).endsWith('/machines/managed/actions/get')) return { status: 200, data: managed };
        throw new Error('Unexpected Session Home write');
      });
      onTestFinished(() => { get.mockRestore(); post.mockRestore(); withdrawActiveProjectAccountRowsSnapshot(); });
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
      const result = await runWithServerHttpBaseUrl(homeUrl, () => coordinate({
        operationId: 'child-session-operation', actionInput: { sessionId: 'session-child-linked', targetMachineId: 'target',
          accountServerId: home, targetPath: '/target', workspaceAction: kind === 'relationship'
            ? { kind, relationshipId: relation.relationshipId, flushBeforeCommit: true } : { kind } },
        start: async () => { stoppedSource = true; throw new Error('Source must not stop when target bootstrap is unavailable'); },
        signal: new AbortController().signal, publishOwnerUpdate() {},
      }));
      expect(result).toMatchObject({ ok: false, errorCode: 'peer_unavailable' });
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
    const callMachine = vi.fn(async (input: { method: string }) => (
      input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3
        ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
        : { ok: true }
    ));
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token' } as never),
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
      prepare: vi.fn(async (input: { operationId: string }) => ({ kind: 'linked_workspace' as const, operationId: input.operationId, action: { kind: 'linked_workspace' as const } })),
      finalize: vi.fn(), commit: vi.fn(), abort: vi.fn(async () => undefined),
    };
    const callMachine = vi.fn(async (input: { method: string; request: unknown }) => {
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      return { ok: true };
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token' } as never),
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
      prepare: vi.fn(async () => prepared),
      finalize: vi.fn(async () => prepared),
      commit: vi.fn(async () => prepared),
      abort: vi.fn(async () => undefined),
    };
    const callMachine = vi.fn(async () => {
      throw Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
      });
    });
    const coordinate = createTrackedSessionHandoffCoordinator({
      expectedAccountServerId: 'server-1',
      readCredentials: async () => ({ token: 'token' } as never),
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
    expect(callMachine).toHaveBeenCalledTimes(3);
    expect(callMachine).toHaveBeenNthCalledWith(1, expect.objectContaining({
      machineId: 'target-1',
      method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3,
    }));
  });

  it('routes the accepted handoff through the existing source and target daemon primitives', async () => {
    const calls: Array<{ machineId: string; method: string; request: unknown; timeoutMs?: number | null }> = [];
    let resultGets = 0;
    const callMachine = vi.fn(async (input: { machineId: string; method: string; request: unknown; timeoutMs?: number | null }) => {
      calls.push(input);
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3) {
        return { ok: false, errorCode: 'not_found', error: 'pending' };
      }
      if (input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3) {
        resultGets += 1;
        if (resultGets === 1) return { ok: false, errorCode: 'not_found', error: 'pending' };
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
        return {
          handoffId: 'handoff-1',
          transitionRevision: 3,
          status: {
            handoffId: 'handoff-1', status: 'in_progress', phase: 'staging_target',
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
      readCredentials: async () => ({ token: 'token' } as never),
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
      handoffTargetReplacementApprovalReceiptId: 'approval-receipt-1',
    });
    expect(calls.map(({ machineId, method }) => [machineId, method])).toEqual([
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V3],
      ['target-1', RPC_METHODS.SPAWN_HAPPY_SESSION],
      ['target-1', RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE],
      ['target-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3],
      ['source-1', RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V3],
    ]);
    expect((calls[4]!.request as { sessionId?: string }).sessionId).toBe('session-1');
    expect(calls[0]!.request).toEqual(expect.objectContaining({
      targetPath: '/target/workspace/packages/app',
      workspaceRootPath: '/target/workspace',
      workspaceSessionRelativeCwd: 'packages/app',
    }));
    expect(calls[4]!.timeoutMs).toBe(5 * 60_000);
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
});
