import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ExternalActionDaemonDispatchRequestSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { exercisePublicPackagePlanApply } from '@/testkit/machines/nativeSoftwareInstallFlow';
import { createExternalActionHomeProcessForTests } from '../../../../server/sources/testkit/externalActionExecution.testkit.mjs';

describe('Machine updates public read', () => {
  it.skipIf(process.platform === 'win32').each([
    { accountEncryptionMode: 'plain', credential: 'keyless', accountRecoverySecret: undefined },
    { accountEncryptionMode: 'e2ee', credential: 'dataKey', accountRecoverySecret: undefined },
    { accountEncryptionMode: 'e2ee', credential: 'legacy', accountRecoverySecret: new Uint8Array(32).fill(29) },
  ] as const)(
    'opens $accountEncryptionMode/$credential updates Plan through the installed daemon without applying updates',
    async ({ accountEncryptionMode, accountRecoverySecret }) => {
      await exercisePublicPackagePlanApply('native-confirm', false, async fixture => {
        const stored = fixture.readHomeMachine();
        if (typeof stored.dataEncryptionKey !== 'string') throw new Error('Expected Machine key envelope or Plain marker');
        const manager: unknown = Reflect.get(fixture.client, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('Expected installed daemon RPC owner');
        const home = await createExternalActionHomeProcessForTests({
          serverIdentityId: 'srv_home', accountId: 'alice', machineId: fixture.machine.id,
          installationId: fixture.installation.installationId, installationPublicKey: fixture.pair.publicKey,
          authentication: 'present_user', accountEncryptionMode,
          machineStoredContent: { metadata: stored.metadata, dataEncryptionKey: stored.dataEncryptionKey },
          dispatch: async packet => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(packet.params);
            expect(request.executionAuthorization?.binding.accountEncryptionMode).toBe(accountEncryptionMode);
            expect(request.envelope.v).toBe(accountEncryptionMode === 'plain' ? 1 : 2);
            return manager.handleRequest(packet);
          },
        });
        const post = vi.mocked(axios.post);
        const boundaryPost = post.getMockImplementation();
        if (!boundaryPost) throw new Error('Expected native Home HTTP boundary');
        // Substitute only HTTP: minting, authorization verification and socket
        // relay run in the real Home, then enter the installed daemon RPC owner.
        post.mockImplementation(async (url, body, options) => {
          const path = new URL(String(url)).pathname;
          if (!path.startsWith('/v1/actions/')) return boundaryPost(url, body, options);
          const headers = new AxiosHeaders(options?.headers);
          if (headers.has('authorization')) headers.set('authorization', `Bearer ${home.token}`);
          const strings: Record<string, string> = {};
          for (const [key, value] of headers) if (typeof value === 'string') strings[key] = value;
          const response = await home.request('POST', path, body, strings,
            options?.signal instanceof AbortSignal ? options.signal : undefined);
          if (response.status !== 200) throw new Error(`Real Home refused ${path}: ${response.status}`);
          return response;
        });
        try {
        const metadataBefore = fixture.machine.metadata?.setup;
        for (const mode of ['effects', 'check'] as const) {
          const result = await fixture.publicExecutor.execute('machines.setup.plan', {
            homeId: 'srv_home', machineId: fixture.machine.id, updates: { scope: 'security' }, mode,
          }, { actionRequestId: mode === 'effects'
            ? '3cdca65f-946d-443e-bb2d-57bdfce7373d'
            : '31cf35a9-1690-4e6d-8116-8ad2e23cdb18' });
          expect(result).toMatchObject({ ok: true });
          if (!result.ok) throw new Error(`Updates ${mode} refused: ${result.errorCode}`);
          const plan = MachineSetupPlanResultV1Schema.parse(result.result);
          expect(plan.updates?.observation).toMatchObject({
            backend: 'apt', status: 'drifted', pendingAll: 1, pendingSecurity: 1, rebootNeeded: false,
          });
          expect(fixture.machine.daemonState?.setup?.updates).toEqual(plan.updates?.observation);
          expect(fixture.machine.metadata?.setup).toEqual(metadataBefore);
        }
        expect(JSON.parse(await readFile(fixture.statePath, 'utf8'))).toMatchObject({ effects: [] });
        } finally {
          post.mockImplementation(boundaryPost);
          await home.close();
        }
      }, undefined, undefined, accountEncryptionMode, accountRecoverySecret);
    }, 120_000);
});
