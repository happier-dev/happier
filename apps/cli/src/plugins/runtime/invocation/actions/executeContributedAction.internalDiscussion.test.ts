import { expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1, PLUGIN_MANIFEST } from '@happier-dev/plugins-scm-github/manifest';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { EXTERNAL_TASK_DISCUSSION_ID_PREFIX } from '@happier-dev/protocol/discussions/references';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { executeContributedAction } from './executeContributedAction';

it('refuses public provider comments from Internal Discussion inputs before approval or execution', async () => {
  const action = { pluginId: PLUGIN_MANIFEST.id, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate };
  const sendToProvider = vi.fn(async () => ({ posted: true }));
  const actionsSettings = normalizeActionsSettingsV1(undefined);
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{
      manifest: {
        schemaVersion: 2, id: action.pluginId, version: '1.0.0', displayName: 'Provider fixture',
        engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        contributes: { actions: [{
          id: action.localId, title: 'Comment', scopes: ['global'], surfaces: ['agent', 'plugin', 'ui'],
          placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe',
        }] },
      },
      files: { 'daemon.mjs': 'export function activate() {}' },
      instantiateCommittedModule: () => ({ activate: (api: PluginApi) => api.actions.register(action.localId, sendToProvider) }),
    }],
    resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
    })),
    runtimeOptions: {
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: { getActionsSettings: () => actionsSettings } },
      resolveCurrentMachineId: () => 'machine',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine' }),
    },
  });
  try {
    const approvalContext = (discussionId: string) => ({
      surface: 'agent' as const, authority: 'account_automation' as const,
      serverId: 'home', actionRequestId: 'comment-request', defaultSessionId: 'session',
      actionCaller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      sessionInputSource: {
        sourceSessionId: 'session', sourceInputId: 'input', sourceTurnId: 'turn', via: 'action' as const,
        discussionAddressing: { discussionId, messageId: 'message', throughSeq: 1, participantSessionId: 'session' },
      },
    });
    const ordinary = approvalContext('ordinary-discussion');
    const internal = approvalContext(`${EXTERNAL_TASK_DISCUSSION_ID_PREFIX}1234`);
    const invocation = { runtimeRegistry: fixture.registry, actionsSettings,
      actionId: buildQualifiedPluginContributionKey(action), input: {}, context: { surface: 'agent' as const } };
    expect(await executeContributedAction({ ...invocation, approvalContext: ordinary })).toMatchObject({
      matched: true, result: { ok: true, result: { posted: true } },
    });
    const refused = {
      matched: true, result: { ok: false, errorCode: 'discussion_internal_reply_required', actionHandlerInvocation: 'notStarted' },
    };
    expect(await executeContributedAction({ ...invocation, approvalContext: internal })).toMatchObject(refused);

    const origin = buildApprovalExecutionOriginV1({ actionId: ACTION_INVOKE_ACTION_ID_V1,
      input: { action, input: {} }, targetSessionId: null, context: internal });
    if (!origin) throw new Error('The test must carry a retained approval origin');
    expect(await executeContributedAction({ ...invocation, approvalContext: ordinary, approvalExecutionOrigin: origin }))
      .toMatchObject(refused);
    expect(sendToProvider).toHaveBeenCalledTimes(1);
  } finally { await fixture.dispose(); }
});
