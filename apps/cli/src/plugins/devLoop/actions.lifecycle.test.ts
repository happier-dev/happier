import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executePluginDevLoopAction } from './actions';
import fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentSetActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createCliPluginAdministrationActionDeps } from '@/session/actions/cliActionDeps/pluginAdministration';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectPluginMutationResult } from '../../../../ui/sources/components/settings/plugins/model/pluginMarketplaceModel';

const daemon = vi.hoisted(() => ({ request: vi.fn(), ensure: vi.fn(async () => {}) }));
// The daemon control channel is the genuine process boundary. Action admission,
// input parsing and the lifecycle adapter remain real below the public executor.
vi.mock('@/daemon/controlClient', async (original) => ({
  ...await original<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemon.request,
}));
vi.mock('@/daemon/ensureDaemon', () => ({ ensureDaemonRunningForSessionCommand: daemon.ensure }));

describe('plugin lifecycle Actions', () => {
  beforeEach(() => {
    daemon.request.mockReset();
    daemon.request.mockResolvedValue({ kind: 'committed', pluginId: 'acme.plugin', desiredGeneration: 'generation-2',
      appliedGeneration: 'generation-2', pendingSurfaces: [] });
  });

  it('disables and re-enables a bundled plugin for the Account without selecting a release or changing Machine state', async () => {
    const app = fastify();
    const pluginId = 'happier.language.markdown';
    let intent: { pluginId: string; desiredVersion: null; enabled: boolean; offlineUiHosting: 'disabled'; writableCollections: []; revision: string } | null = null;
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 0, hostingCapability: { enabled: false }, intent, release: null, uiArtifacts: [], packageAssets: [],
    }));
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'], async request => {
      const input = PluginAvailabilityIntentSetActionInputV1Schema.parse(request.body);
      expect(input.expectedRevision).toBe(intent?.revision ?? null);
      expect(input.desiredVersion).toBeNull();
      intent = { pluginId, desiredVersion: null, enabled: input.enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: intent ? '2' : '1' };
      return { intent };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: 'http://plugin-account.test' });
    try {
      const administration = createCliPluginAdministrationActionDeps({ credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.fixture`, encryption: null },
        serverHttpBaseUrl: 'http://plugin-account.test' }, { approvalsStore: null, notSupported: () => { throw new Error('not_supported'); },
        readRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {},
        resolveCurrentSessionValue: async () => null,
      });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => false,
        pluginsDevLoopAction: administration.pluginsDevLoopAction });
      for (const actionId of ['plugins.disable', 'plugins.enable'] as const) {
        const result = await executor.execute(actionId, { pluginId, scope: 'account' }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { ok: true, pluginId, scope: 'account', enabled: actionId === 'plugins.enable' } });
        if (!result.ok) throw new Error('Account enablement Action failed');
        const method = actionId === 'plugins.enable' ? 'enable' : 'disable';
        expect(projectPluginMutationResult(result.result, method, pluginId).kind).toBe('committed');
        expect(projectPluginMutationResult(result.result, method, 'another.plugin').kind).toBeNull();
        expect(projectPluginMutationResult(result.result, method === 'enable' ? 'disable' : 'enable', pluginId).kind).toBeNull();
        expect(projectPluginMutationResult(Object.assign({}, result.result, { ok: false }), method, pluginId).kind).toBeNull();
      }
      expect(intent).toMatchObject({ enabled: true, desiredVersion: null, revision: '2' });
      expect(daemon.request).not.toHaveBeenCalled();
      const dispatch = administration.pluginsDevLoopAction;
      if (!dispatch) throw new Error('Plugin Action dispatcher unavailable');
      expect(await dispatch({ actionId: 'plugins.disable', input: { pluginId, scope: 'account' }, context: { surface: 'api',
        externalActionCredential: { accountId: 'another-account', principalId: 'another-account', credentialId: 'other-token', grant: API_TOKEN_FULL_GRANT_V1 },
      } })).toMatchObject({ ok: false, errorCode: 'permission_denied' });
      expect(intent).toMatchObject({ enabled: true, revision: '2' });
    } finally { restore(); await app.close(); }
  });

  it.each([
    ['plugins.enable', 'enable'],
    ['plugins.disable', 'disable'],
    ['plugins.rollback', 'rollback'],
    ['plugins.trust.forget', 'forgetTrust'],
    ['plugins.update_policy.set', 'setUpdatePolicy'],
    ['plugins.uninstall', 'uninstall'],
  ] as const)('admits %s for UI and preserves the daemon-owned change', async (actionId, kind) => {
    const input = { machineId: 'machine-1', pluginId: 'acme.plugin',
      ...(kind === 'setUpdatePolicy' ? { policy: 'pinned' } : {}) };
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      isActionApprovalRequired: () => false,
      pluginsDevLoopAction: executePluginDevLoopAction,
    });
    const outcome = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(outcome).toMatchObject({ ok: true, result: { ok: true, pluginId: 'acme.plugin', change: { kind: 'committed' } } });
    expect(daemon.request).toHaveBeenCalledWith(expect.objectContaining({ kind, pluginId: 'acme.plugin' }));
    const outputSchema = getActionSpec(actionId).outputSchema;
    if (!outputSchema) throw new Error('Lifecycle Action output schema missing');
    expect(outputSchema.safeParse(outcome.ok ? outcome.result : undefined).success).toBe(true);
  });

  it('does not reach the daemon when lifecycle Actions are Off or awaiting Ask-first approval', async () => {
    const disabled = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionEnabled: () => false, pluginsDevLoopAction: executePluginDevLoopAction });
    expect(await disabled.execute('plugins.disable', { pluginId: 'acme.plugin' }, { surface: 'ui' }))
      .toMatchObject({ ok: false });
    let request: unknown;
    const ask = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => true, pluginsDevLoopAction: executePluginDevLoopAction,
      approvalsCreate: async (args) => { request = args.request; return { artifactId: 'approval-plugin' }; },
    });
    expect(await ask.execute('plugins.disable', { machineId: 'machine-1', pluginId: 'acme.plugin' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', actionRequestId: 'disable-1',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(request).toMatchObject({ actionId: 'plugins.disable', actionArgs: { machineId: 'machine-1', pluginId: 'acme.plugin' } });
    expect(daemon.request).not.toHaveBeenCalled();
  });
});
