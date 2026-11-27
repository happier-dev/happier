import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createPlainProjectAccountRefRow, createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => vi.restoreAllMocks());

it('addresses Stop to the committed controller when invoked from the linked Worker', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'happier-sync-stop-' }, async () => {
    const serverId = 'srv_sync_home';
    const relationshipId = 'copy-link';
    const ref = (id: string, machineId: string) => createPlainProjectAccountRefRow({
      id, machineId, serverId, rootPath: `/work/${id}`, createdAtMs: 1,
    });
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const key = { kind: 'relationship-graph' };
    const rows = createProjectAccountRowsHttpBoundary([
      ref('source-ref', 'source'), ref('target-ref', 'worker'),
      { key, revision: 1, content: { t: 'plain', v: { key, value: { relationships: [{
        v: 1, relationshipId, controllerMachineId: 'source',
        alphaWorkspaceRefId: 'source-ref', betaWorkspaceRefId: 'target-ref',
        mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 2,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      }] } } } },
    ]);
    vi.spyOn(axios, 'post').mockImplementation(rows);
    const machineReads: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const path = new URL(String(config.url)).pathname;
      if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
        return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
      }
      return { status: 404, data: { error: 'not_found' } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.startsWith('/v1/machines/')) machineReads.push(path.slice('/v1/machines/'.length));
      return { status: 404, data: { error: 'not_found' } };
    });
    const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'actor', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      externalActionClient: true, serverId, serverIdentityId: serverId, serverApiUrl: 'https://sync-cli.test',
      machineId: 'worker', actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({
        v: 1, approvalWaivedSurfaces: { 'workspace.sync.relationship.terminate': ['cli'] },
      }) },
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: serverId } } }),
      }),
    });
    const result = await executor.execute('workspace.sync.relationship.terminate',
      { relationshipId, controllerMachineId: 'worker' }, { surface: 'cli', authority: 'present_user' });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(machineReads).toEqual(['source']);
  });
});
