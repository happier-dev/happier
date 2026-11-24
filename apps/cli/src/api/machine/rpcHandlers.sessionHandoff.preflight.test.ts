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
import axios from 'axios';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, projectExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';

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

afterEach(async () => { vi.restoreAllMocks(); if (filesystem.root) await rm(filesystem.root, { recursive: true, force: true }); });

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

  // A Manage member hands off their e2ee Session from another Account's SOURCE to their own TARGET.
  // Their retained custody holds the Account recovery secret (`legacy`), as the app's sign-in stores it.
  it('prepares the TARGET preflight child from the requester Account secret', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const secret = new Uint8Array(32).fill(9);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'handoff-root', binding: {
      accountId: 'member', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_home',
      machineId: 'source', custodianAccountId: 'owner', installationId: 'source-installation', actionId: 'session.handoff',
      requestId: 'handoff-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'source' },
      accountEncryptionMode: 'e2ee', handoffAdmission: { sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target',
        sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
    } });
    // Home is the HTTP boundary: it checks the SOURCE installation signature and opens the
    // sealed request with the requester Account's content key, as its child admission does.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const signed = verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'session.handoff',
        target: root.binding.target, installationId: 'source-installation', requestId: root.binding.requestId,
        method: 'POST', path: new URL(String(url)).pathname, body, publicKey: keys.publicKey,
        signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) });
      const opened = openExternalActionRequestV2({ envelope: request.envelope,
        binding: projectExternalActionEncryptionBindingV2({ ...root.binding, target: request.envelope.target }),
        material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) },
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
      if (!signed || !opened) return { status: 403, data: { error: 'action_forbidden' } };
      return { status: 200, data: { v: 1, token: 'target-preflight-child', binding: { ...root.binding,
        machineId: 'target', installationId: 'target-installation', target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        handoffPreflight: { rootRequestId: root.binding.requestId, rootRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } } } };
    });
    const targetCalls: unknown[] = [];
    const preflight = createSessionHandoffPreflightMachineRpc({
      callMachine: async input => { targetCalls.push(input.externalAction?.context.externalActionExecutionAuthorization?.token);
        return { protocolVersion: 3, atomicTargetResume: false, targetCleanup: false, existingState: true }; },
      authorization: { serverHttpBaseUrl: 'https://home.test',
        readSourceInstallation: () => ({ machineId: 'source', installationId: 'source-installation', privateKey: keys.secretKey }) },
    });
    const result = await preflight({ machineId: 'target', method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET,
      credentials: { token: 'member-token', encryption: { type: 'legacy', secret } },
      request: { sessionId: 'session', sourceMachineId: 'source', targetMachineId: 'target', targetPath: '/target',
        sourceSessionStorageMode: 'persisted' },
      context: { surface: 'ui', authority: 'present_user', externalActionExecutionAuthorization: root,
        signal: new AbortController().signal } as RpcActionExecutorContext });
    expect(result).toMatchObject({ protocolVersion: 3 });
    expect(post).toHaveBeenCalledOnce();
    expect(targetCalls).toEqual(['target-preflight-child']);
  });
});
