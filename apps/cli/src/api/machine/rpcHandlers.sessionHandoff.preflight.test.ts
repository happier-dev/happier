import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineRpcHandlers } from './rpcHandlers';
import { createSessionHandoffPreflightMachineRpc } from '@/session/handoff/sessionHandoffPreflightMachineRpc';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

const filesystem = vi.hoisted(() => ({ root: '' }));
// Configuration and stored credentials are process/filesystem boundaries, not handoff logic.
vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration,
    get activeServerDir() { return `${filesystem.root}/server`; },
    get happyHomeDir() { return filesystem.root; } } };
});
vi.mock('@/persistence', async importOriginal => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return { ...actual, readStoredCredentials: async () => null };
});

afterEach(async () => { if (filesystem.root) await rm(filesystem.root, { recursive: true, force: true }); });

describe('installed source handoff preflight', () => {
  it('negotiates both V3 peers and returns missing target state before source stop', async () => {
    filesystem.root = await mkdtemp(join(tmpdir(), 'happier-installed-handoff-preflight-'));
    let stopped = false;
    const visited: string[] = [];
    const callMachine = createSessionHandoffPreflightMachineRpc({ callMachine: async input => {
      visited.push(`${input.machineId}:${input.method}`);
      return input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET
        ? { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true }
        : { ok: false, errorCode: 'existing_session_state_unavailable' };
    } });
    const manager = new RpcHandlerManager({ scopePrefix: 'source', localMachineId: 'source', encryptionMode: 'plain',
      // The authenticated transport is the only ingress mock.
      authorizeRequest: async () => ({ ok: true }), logger: () => undefined });
    registerMachineRpcHandlers({ rpcHandlerManager: manager,
      handlers: { spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Unexpected launch' }),
        stopSession: async () => { stopped = true; return { status: 'stopped' }; },
        isSessionActive: async () => true, requestShutdown: () => undefined,
        loadLocalSessionMetadata: async () => ({ exportMetadata: { machineId: 'source', path: '/source', transcriptStorage: 'persisted' } }),
        directPeerTransfer: { publishTransfer: () => [], clearPublishedTransfer: () => undefined } },
      deps: {
        sessionHandoffPreflight: { readCredentials: async () => ({ token: 'requester', encryption: null }), callMachine },
        requesterBootstrapBoundary: { serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', happyHomeDir: filesystem.root,
          getObservedServerIdentityId: () => 'home' },
        resolveServerFeaturesSnapshot: async () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
          features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true } } } }, capabilities: {} }) }),
      } });
    expect(await manager.handleRequest({ method: `source:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`, params: {} }))
      .toMatchObject({ protocolVersion: 3, existingState: true });
    expect(await manager.handleRequest({ method: `source:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`,
      params: { sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/target',
        sessionStorageMode: 'persisted', stateTransfer: 'existing', workspaceAction: { kind: 'none' },
        preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer' } }))
      .toMatchObject({ ok: false, errorCode: 'existing_session_state_unavailable' });
    expect(stopped).toBe(false);
    expect(visited).toContain(`source:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`);
    expect(visited).toContain(`target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET}`);
    expect(visited).toContain(`target:${RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3}`);
  });
});
