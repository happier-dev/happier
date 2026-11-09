import axios from 'axios';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { buildSessionWorkspaceLocationV1 } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import * as persistence from '@/persistence';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { sealSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createReplayMessagesPage } from '@/session/replay/replayMessagesFixture.testkit';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import type { RpcHandler } from '@/api/rpc/types';
import { createRpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineSessionRpcHandlers } from '@/api/machine/rpcHandlers.sessions';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createMachineSessionLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
let runtimeHome = '';
beforeAll(async () => {
  runtimeHome = await createTempDir('happier-fork-workspace-');
  const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: runtimeHome,
    resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
      registeredRootId: `fork-workspace:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
  });
  const result = await pluginReloadController.adoptPreparedRuntimeRegistry({ registry,
    changedPluginIds: ['happier.agent.claude'], durableRevision: 1, runningSessionDisposition: 'retainRunningSessions' });
  expect(result.ok).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await pluginReloadController.shutdown();
  if (runtimeHome) await removeTempDir(runtimeHome);
});

describe('fork workspace path through the lifecycle RPC', () => {
  it.each([
    ['plain', 'bound', '', 'fork', undefined], ['e2ee', 'bound', '', 'fork', undefined],
    ['plain', 'admitted', '', 'fork', undefined], ['plain', 'replacement', '', 'fork', undefined],
    ['plain', 'unknown', '', 'fork', undefined], ['plain', 'unknown', '/agent/project', 'fork', undefined],
    ['plain', 'bound', '', 'fork', 'profile:caller'], ['plain', 'bound', '', 'fork', null],
    ['plain', 'bound', '', 'continue', undefined], ['e2ee', 'bound', '', 'continue', undefined],
    ['plain', 'bound', '', 'continue', 'profile:caller'], ['plain', 'bound', '', 'continue', null],
  ] as const)('preserves child metadata for a %s Account (%s receiver, root %s, %s, profile %s)', async (mode, receiver, candidatePath, family, approvalProfileId) => {
    const secret = new Uint8Array(32).fill(9);
    const credentials: persistence.StoredCredentials = { token: 'fixture-token',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret } };
    const parentSessionId = 'c1234567890123456789012345';
    const machineId = 'machine-1';
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: mode,
      metadata: { path: candidatePath, host: 'fixture-host', machineId, flavor: 'claude', approvalProfileId: 'profile:source',
        sessionWorkspaceLocationV1: buildSessionWorkspaceLocationV1({ machineId,
          agentPath: '/agent/project', machinePath: '/host/project' }) }, agentState: null,
      ...(mode === 'plain' ? { storedContentMode: 'plain' as const }
        : { storedContentMode: 'e2ee' as const, encryptionKey: secret, encryptionVariant: 'legacy' as const }),
    });
    const parent = createCurrentSessionProjectionRecordFixture({
      ...createSessionNotificationContextFixture(parentSessionId), seq: 1, encryptionMode: mode,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, agentState: fields.agentState,
    });
    const messages = createReplayMessagesPage({ hasMore: false, messages: [{ seq: 1, createdAt: 1,
      content: sealSessionStoredContent({ ...(mode === 'plain' ? { mode: 'plain' as const, ctx: null }
        : { mode: 'e2ee' as const, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } }),
        payload: { role: 'user', content: { type: 'text', text: 'Continue the workspace task' } } }),
    }] });
    let createdOwnerMetadata: unknown;
    const unexpectedRequests: string[] = [];
    // Authentication/persistence and HTTP are system boundaries. RPC dispatch,
    // owner-envelope opening, Agent resolution, replay and creation stay real.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.stubGlobal('fetch', vi.fn(async value => {
      const url = String(value);
      if (url.endsWith('/v1/features')) return Response.json({ features: {}, capabilities: {
        encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: mode },
      } });
      if (url.endsWith('/v1/account/profile')) return Response.json({ id: 'fixture-account' });
      unexpectedRequests.push(url);
      return Response.json({}, { status: 404 });
    }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${parentSessionId}`) return { status: 200, data: { session: parent } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
      if (path === `/v1/sessions/${parentSessionId}/messages`) return { status: 200, data: messages };
      if (path === '/v2/account/settings') return { status: 200,
        data: AccountSettingsV2GetResponseSchema.parse({ content: null, version: 0 }) };
      unexpectedRequests.push(path);
      return { status: 404, data: {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/sessions') {
        createdOwnerMetadata = body && typeof body === 'object' ? Reflect.get(body, 'ownerMetadata') : undefined;
        // Stop at the real Home creation boundary; this regression does not
        // simulate a daemon runner or claim native Agent startup succeeded.
        return { status: 503, data: {} };
      }
      unexpectedRequests.push(path);
      return { status: 404, data: {} };
    });
    const rpcHandlers = new Map<string, RpcHandler>();
    const machineHandlers = {
      spawnSession: async () => { throw new Error('Home refused creation before OS launch'); },
      stopSession: async () => { throw new Error('Replay must not stop its parent'); },
      requestShutdown: () => undefined,
    };
    const manager = createRpcHandlerManager({ scopePrefix: machineId, scopeKind: 'machine', localMachineId: machineId,
      encryptionKey: secret, encryptionVariant: 'legacy', encryptionMode: 'plain' });
    if (receiver === 'bound') registerMachineSessionRpcHandlers({ rpcHandlerManager: manager,
      handlers: machineHandlers, deps: { currentMachineId: machineId } });
    registerSessionLifecycleRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => { rpcHandlers.set(method, handler); } },
      actionExecutor: createMachineSessionLifecycleActionExecutor({
        handlers: machineHandlers,
        ...(receiver === 'bound' || receiver === 'replacement' ? { deps: { currentMachineId: machineId } } : {}),
      }), actionIds: ['session.fork', 'session.continue_with_replay'],
    });
    const method = family === 'fork' ? RPC_METHODS.SESSION_FORK : RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY;
    const profileSelection = approvalProfileId === undefined ? {} : { approvalProfileId };
    const input = family === 'fork'
      ? { v: 1, parentSessionId, forkPoint: { type: 'latest' }, strategy: 'replay', ...profileSelection }
      : { directory: '/host/project', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        replay: { previousSessionId: parentSessionId }, ...profileSelection };
    const result = receiver === 'bound'
      ? await manager.invokeLocal(method, input)
      : await rpcHandlers.get(method)?.(input,
      receiver === 'admitted' || receiver === 'replacement' ? {
        signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
          machineId: receiver === 'replacement' ? 'machine-new' : machineId,
          installationId: 'fixture-installation', role: 'use', encryptionMode: mode },
      } : undefined);
    if (!candidatePath && (receiver === 'replacement' || receiver === 'unknown')) {
      expect(result).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
      expect(createdOwnerMetadata).toBeUndefined();
      expect(unexpectedRequests).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ ...(family === 'fork' ? { ok: false } : { type: 'error' }), errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'Unexpected status from /v1/sessions: 503' });
    const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: mode,
      envelope: createdOwnerMetadata, ...(mode === 'e2ee' ? { material: { type: 'legacy', secret } as const } : {}) });
    expect(opened).toMatchObject({ ok: true, ownerMetadata: { workspace: { path: receiver === 'unknown' ? candidatePath : '/host/project' },
      runtime: { approvalProfileId: approvalProfileId === undefined ? 'profile:source' : approvalProfileId },
      history: { replaySeedV1: { sourceSessionId: parentSessionId, seedText: expect.stringContaining('Continue the workspace task') } },
    } });
    expect(unexpectedRequests).toEqual([]);
  });
});
