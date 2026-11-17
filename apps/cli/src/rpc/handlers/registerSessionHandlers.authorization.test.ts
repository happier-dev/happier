import { describe, expect, it } from 'vitest';

import { SESSION_RPC_METHODS, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/rpc';

import { SESSION_TRANSCRIPT_RPC_SCOPES } from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { registerSessionControlHandlers } from './sessionControls';
import { registerSessionUserMessageSendHandler } from './sessionUserMessageSend';
import { ApiClient } from '@/api/api';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { RpcHandlerMap } from '@/api/rpc/types';
import { createServer } from 'node:http';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { MachineInstallationProofV1Schema, RequesterSessionCurrentnessPurposeV1Schema,
  verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';

describe('Session RPC registration authorization coverage', () => {
  it('preserves admitted owner person and Account automation while local cancellation closes the actual Session receiver', async () => {
    await withTempDir('session-owner-receipt-', async directory => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
      env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: 'session-owner-profile' });
      reloadConfiguration();
      const installation = await readOrCreateInstallationIdentity();
      let current = true;
      let verifications = 0;
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/machines/machine/admission/verify') {
          response.writeHead(404); response.end(); return;
        }
        let raw = '';
        for await (const chunk of request) raw += chunk;
        // HTTP is the boundary; proof signing/verification and receipt schemas remain real.
        const body = JSON.parse(raw) as Record<string, unknown>;
        const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
        const purpose = RequesterSessionCurrentnessPurposeV1Schema.parse(body.purpose);
        verifications++;
        const valid = current && request.url === '/v1/machines/machine/admission/verify'
          && request.headers.authorization === 'Bearer synthetic-owner-token'
          && purpose.sessionId === 'session-owner' && verifyMachineInstallationProof({ publicKey: installation.publicKey,
            proof: MachineInstallationProofV1Schema.parse(body.proof), payload: { version: 1, accountId: 'owner',
              machineId: 'machine', installationId: installation.installationId, rpcAdmission: { context, purpose } } });
        response.writeHead(valid ? 200 : 403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ v: 1, ok: valid }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing Home fixture address');
      env.patch({ HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}` });
      reloadConfiguration();
      const api = await ApiClient.create({ token: 'synthetic-owner-token', encryption: null });
      api.setLocalMachineId('machine');
      let home: string | null = 'srv_session_owner';
      api.setServerFeaturesSnapshotProvider(() => home ? { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: home } } }) } : undefined);
      const client = api.sessionSyncClient(createPlainSessionFixture({ id: 'session-owner' }), { durableMutationDeliveryInitiallyActive: false });
      const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: installation.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
      const call = (callerAuthority: 'present_user' | 'account_automation') => client.rpcHandlerManager.handleRequest({
        method: `session-owner:${RPC_METHODS.PREVIEW_ENV}`, callerAuthority, machineAdmission: admission,
        params: { keys: ['MI1_SESSION_OWNER'], extraEnv: { MI1_SESSION_OWNER: 'owner-operation' } },
      });
      try {
        for (const authority of ['present_user', 'account_automation'] as const) {
          expect(await call(authority)).toMatchObject({ values: { MI1_SESSION_OWNER: { value: 'owner-operation' } } });
        }
        const readsBeforeAgent = verifications;
        const params = { keys: ['MI1_SESSION_OWNER'], extraEnv: { MI1_SESSION_OWNER: 'owner-operation' } };
        expect(await client.rpcHandlerManager.invokeLocal(RPC_METHODS.PREVIEW_ENV, params, {
          rpcContext: { callerAuthority: 'account_automation', machineAdmission: admission },
          localActionContext: { actionCaller: { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 } },
        })).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
        expect(verifications).toBe(readsBeforeAgent);
        expect(await client.rpcHandlerManager.handleRequest({ method: `session-owner:${RPC_METHODS.BASH}`,
          params: { argv: [process.execPath, '-e', 'process.stdout.write("owner-command")'], cwd: directory },
          machineAdmission: admission, callerAuthority: 'present_user',
        })).toMatchObject({ success: true, stdout: 'owner-command' });
        expect(await client.rpcHandlerManager.handleRequest({ method: `session-owner:${RPC_METHODS.BASH}`,
          params: { argv: [process.execPath, '-e', 'process.stdout.write("owner-command")'], cwd: directory },
          machineAdmission: admission, callerAuthority: 'account_automation',
        })).toMatchObject({ success: true, stdout: 'owner-command' });
        current = false;
        // Home admitted this packet; the receiver retains that authority for its
        // finite effect rather than asking Home to authorize it a second time.
        expect(await call('present_user')).toMatchObject({ values: { MI1_SESSION_OWNER: { value: 'owner-operation' } } });
        expect(verifications).toBe(0);
        const requestId = 'owner-preview-cancel';
        const cancelled = client.rpcHandlerManager.handleRequest({
          method: `session-owner:${RPC_METHODS.PREVIEW_ENV}`, callerAuthority: 'present_user',
          machineAdmission: admission, requestId,
          params: { keys: ['MI1_CANCELLED_OWNER'], extraEnv: { MI1_CANCELLED_OWNER: 'cancelled-private-value' } },
        });
        client.rpcHandlerManager.cancelTransportRequest(requestId);
        const cancelledResponse = await cancelled;
        expect(cancelledResponse).toMatchObject({ error: expect.any(String) });
        expect(JSON.stringify(cancelledResponse)).not.toContain('cancelled-private-value');
        expect(verifications).toBe(0);
        current = true;
        home = null;
        const reads = verifications;
        expect(await call('present_user')).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
        expect(verifications).toBe(reads);
      } finally {
        await client.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        env.restore(); reloadConfiguration();
      }
    });
  });
  it('refuses protected raw effects on the real Session receiver, including closed local preview', async () => {
    const api = await ApiClient.create({ token: 'session-preview-owner-test', encryption: null });
    const client = api.sessionSyncClient(createPlainSessionFixture({ id: 'session-preview-test' }), {
      durableMutationDeliveryInitiallyActive: false,
    });
    try {
      const response = await client.rpcHandlerManager.invokeLocal(RPC_METHODS.PREVIEW_ENV, {
        keys: ['MI1_PREVIEW_VALUE'], extraEnv: { MI1_PREVIEW_VALUE: 'private-session-runtime-environment' },
      });
      expect(response).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
      expect(JSON.stringify(response)).not.toContain('private-session-runtime-environment');
      // Census the actual receiver, including separately registered typed families.
      const handlers = Reflect.get(client.rpcHandlerManager, 'handlers') as RpcHandlerMap;
      const protectedMethods = [...handlers.keys()].map(method => method.slice('session-preview-test:'.length))
        .filter(method => resolveMachineRpcRoutePolicy(method).requesterExecutionIsolationRequired === true);
      expect(protectedMethods).toContain(RPC_METHODS.PREVIEW_ENV);
      expect(protectedMethods).toContain(RPC_METHODS.BASH);
      for (const method of protectedMethods) {
        expect(await client.rpcHandlerManager.invokeLocal(method, {}), method)
          .toMatchObject({ errorCode: 'agent_isolation_unavailable' });
      }
      const content = { mode: 'plain' as const };
      const method = `session-preview-test:${RPC_METHODS.PREVIEW_ENV}`;
      const callId = '00000000000000000000000000000001';
      const params = await socketRpcCodec.encodeParams(content, { keys: ['MI1_PREVIEW_VALUE'] }, { method, callId });
      const encoded = await client.rpcHandlerManager.handleRequest({ method, params, callerAuthority: 'present_user' });
      expect(await socketRpcCodec.decodeResult(content, { ok: true, result: encoded }, callId))
        .toMatchObject({ errorCode: 'agent_isolation_unavailable' });
    } finally { await client.close(); }
  });

  it('classifies every method installed on the Session RPC registrar', () => {
    const methods = new Set<string>();
    const registrar = {
      hasHandler: (method: string) => methods.has(method),
      registerHandler: (method: string) => {
        methods.add(method);
      },
    };

    registerSessionUserMessageSendHandler(registrar, {
      workingDirectory: '/workspace',
      sessionId: 'session-1',
      getSessionMetadata: null,
      enqueueSessionUserMessage: async () => undefined,
      sessionRuntimeControls: null,
    });
    registerSessionControlHandlers(registrar, {
      getSessionMetadata: null,
      isUsageLimitRecoveryEnabled: null,
      sessionRuntimeControls: null,
      notifyUsageLimitWaitResumeCancelled: null,
    });
    registerActionSpecRpcHandlers({
      rpcHandlerManager: registrar,
      scopes: SESSION_TRANSCRIPT_RPC_SCOPES,
      actionExecutor: {
        execute: async () => ({ ok: false, errorCode: 'not_executed', error: 'not_executed' }),
      },
    });

    expect(
      [...methods]
        .filter((method) => resolveSocketRpcSessionAuthorization(method) === null)
        .sort(),
    ).toEqual([]);
    for (const method of [
      SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
      SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
    ]) {
      expect(methods.has(method), method).toBe(true);
    }
    for (const dynamicallyRegisteredMethod of [
      'session.permission_mode.set',
      'session.permission.respond',
      'session.permission.remote.grants.list',
      'session.permission.remote.grants.revoke',
      'session.user_action.answer',
    ]) {
      expect(resolveSocketRpcSessionAuthorization(dynamicallyRegisteredMethod), dynamicallyRegisteredMethod)
        .not.toBeNull();
    }
  });
});
