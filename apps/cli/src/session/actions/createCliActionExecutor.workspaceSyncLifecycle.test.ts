import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createCliActionExecutor } from './createCliActionExecutor';

afterEach(() => vi.restoreAllMocks());

describe('CLI Workspace Sync relationship lifecycle composition', () => {
  it('dispatches every advertised lifecycle Action to the stable-Home controller RPC', async () => {
    await withTempDir('workspace-sync-lifecycle-', async home => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      const profileId = 'workspace-sync-local-profile';
      const homeId = 'srv_workspace_sync_home';
      const serverUrl = 'https://workspace-sync-home.example.test';
      const relationshipId = 'relationship-a';
      const controllerMachineId = 'controller-machine-a';
      const status = {
        relationshipId,
        controllerMachineId,
        state: 'watching' as const,
        alphaPath: '/workspace/a',
        betaPath: '/workspace/b',
        mode: 'keep_both_in_sync' as const,
        endpointStates: { alpha: null, beta: null },
        conflictCount: 0,
        lastCycleObservedAtMs: 10,
      };
      try {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: {
          [profileId]: {
            id: profileId,
            name: 'Workspace Sync Home',
            serverUrl,
            webappUrl: serverUrl,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
            homeConnectionDescriptorAuthority: 'exact' as const,
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({
              v: 1,
              homeServerIdentityId: homeId,
              canonicalServerUrl: serverUrl,
              revision: 1,
              endpoints: [{ kind: 'https', url: serverUrl }],
            }),
          },
        } }));

        const invoke = vi.fn(async (method: string) => method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH
          ? { status }
          : { ok: true });
        const executor = createCliActionExecutor({
          token: 'workspace-sync-token',
          credentials: { token: 'workspace-sync-token', encryption: null },
          serverId: profileId,
          serverIdentityId: homeId,
          serverHttpBaseUrl: serverUrl,
          sessionId: 'workspace-sync-session',
          mode: 'plain',
          ctx: null,
          pluginActionExecutionOwner: 'current_process',
          machineActionDirectTargetTransport: { machineId: controllerMachineId, invoke },
        });
        const context = {
          surface: 'agent' as const,
          serverId: profileId,
          serverIdentityId: homeId,
          workspaceWrites: 'allow' as const,
          bypassApprovals: true,
        };
        const input = { controllerMachineId, relationshipId };
        const cases = [
          ['workspace.sync.relationship.disable', RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE,
            { v: 1, relationshipId, enabled: false }],
          ['workspace.sync.relationship.enable', RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME,
            { v: 1, relationshipId, enabled: true }],
          ['workspace.sync.relationship.flush', RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
            { v: 1, relationshipId, status }],
          ['workspace.sync.relationship.terminate', RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE,
            { v: 1, relationshipId, terminated: true }],
        ] as const;

        for (const [actionId, method, result] of cases) {
          await expect(executor.execute(actionId, input, context)).resolves.toEqual({ ok: true, result });
          expect(invoke).toHaveBeenLastCalledWith(method, { relationshipId }, {
            localActionContext: { surface: 'agent', authority: 'account_automation' },
          });
        }
        expect(invoke).toHaveBeenCalledTimes(cases.length);
        expect(getActionSpec('workspace.sync.relationship.disable')).toMatchObject({ approvalPolicy: { uiConfirmation: 'direct' } });
        expect(getActionSpec('workspace.sync.relationship.enable')).toMatchObject({ approvalPolicy: { uiConfirmation: 'direct' } });
        expect(getActionSpec('workspace.sync.relationship.flush')).toMatchObject({ approvalPolicy: { uiConfirmation: 'direct' } });
        expect(getActionSpec('workspace.sync.relationship.terminate')).toMatchObject({ approvalPolicy: { uiConfirmation: 'policy' } });
      } finally {
        scope.restore();
        reloadConfiguration();
      }
    });
  });
});
