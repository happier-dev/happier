import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { applyTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createIsolatedFakeClaudeControlShim } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1 } from '../../../protocol/src/automations/automationActionOccurrenceV1';
import { repoRootDir } from '../../src/testkit/paths';
import { buildCurrentSourcePublicPluginFixture } from '../../src/testkit/pluginPlatform/currentManagedStackPluginUiQa';
import { reviewRunHasChildSession } from '../../src/testkit/automationsEverywhereReviewRun';

describe('AE.P02.F10-plugin-reverse-ui', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('settles an actual reverse UI-hosted effect through the published client artifact and real currentness owner', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-plugin-ui-reverse-'));
    const agent = await createIsolatedFakeClaudeControlShim({ testDir: join(testDir, 'reverse-agent'),
      captureEnvironmentKeys: [], logFullStdin: true, scenario: 'session-mcp-tool' });
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true, advertiseRequestObservationEndpoint: true,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_CLAUDE_PATH: agent.executablePath } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const pluginId = 'acme.automation-ui-reverse';
    const actionId = formatQualifiedPluginActionId({ pluginId, localId: 'apply' });
    const pluginRoot = join(testDir, 'client-plugin');
    await mkdir(pluginRoot, { recursive: true });
    const sourceFixture = join(repoRootDir(), 'packages/tests/fixtures/plugin-platform/current-source-native-public');
    await cp(join(sourceFixture, 'tsconfig.json'), join(pluginRoot, 'tsconfig.json'));
    const packageJson = JSON.parse(await readFile(join(sourceFixture, 'package.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ ...packageJson,
      name: '@happier-qa/automation-ui-reverse', exports: { './happier-plugin-ui/effect-client': './client.ts' } }));
    await writeFile(join(pluginRoot, 'index.ts'), [
      "import { definePlugin } from '@happier-dev/plugin-sdk';",
      'const plugin = definePlugin({',
      `id: ${JSON.stringify(pluginId)}, version: '1.0.0', entrypoints: { daemon: './dist/index.js' },`,
      "actions: { apply: { title: 'Apply UI fixture', dangerLevel: 'safe', readOnly: false, scopes: ['global'],",
      "surfaces: ['ui', 'cli', 'mcp', 'agent'], execution: { target: 'client', client: { artifactId: 'effect-client', exportName: 'activate' }, platforms: ['web'] },",
      "inputSchema: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false } } } });",
      'export const manifest = plugin.manifest; export const activate = plugin.activate;',
    ].join('\n'));
    await writeFile(join(pluginRoot, 'client.ts'), [
      "import type { PluginClientApi } from '@happier-dev/plugin-sdk';",
      "export function activate(api: PluginClientApi) { api.actions.register('apply', async input => input); }",
    ].join('\n'));
    await buildCurrentSourcePublicPluginFixture(pluginRoot);
    await applyTrustedLocalPluginFixture({ daemonPort: machine.daemon.state.httpPort,
      controlToken: machine.daemon.state.controlToken, pluginRoot, pluginId, interactionId: 'automation-client-install' });
    const context = { defaultSessionId: session.sessionId, externalActionTarget: { kind: 'machine' as const,
      machineId: machine.target.machineId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    const linked = await actor.executeAsPerson('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the completed UI effect.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } }, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: [actionId] },
    }, context, { action: { pluginId, localId: 'apply' }, machineId: machine.target.machineId });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error('UI effect trigger refused');
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const { connectUiPersonActionClient } = await import('@happier-tests/ui-action-client');
    const action = { pluginId, localId: 'apply' };
    const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
      addressAnchorUrl: fixture.server.baseUrl,
      accountSecret: actor.auth.accountSigningSeed,
      presentedMachineAction: { action, target: { serverIdentityId: fixture.serverId, machineId: machine.target.machineId } },
      withClientActionReverseRuntime: true });
    try {
      await waitFor(async () => ui.hasRegisteredClientActionMethod(machine.target.machineId, RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE)
        && await ui.hasActivatedClientAction(action), { context: 'Published UI client artifact is current and activated by AppShell' });
      fixture.takeRequestObservations();
      const actionRequestId = randomUUID();
      const reverse = await fixture.executeSessionMcpAction(actor,
        { sessionId: session.sessionId, logPath: agent.logPath }, 'action.invoke', { action, input: { mode: 'save' } },
        { actionRequestId });
      expect(reverse, reverse.ok ? undefined : JSON.stringify({ code: reverse.errorCode, error: reverse.error })).toMatchObject({ ok: true, result: { mode: 'save' } });
      const occurrences = fixture.readActionOccurrences().filter(value => value.evidence.actionId === actionId);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({ evidence: { requestId: actionRequestId, phase: 'after', status: 'succeeded' },
        triggers: [{ automationId: saved.set.automationId, triggerId: saved.triggerId, triggerRevision: saved.triggerRevision }] });
      expect(fixture.takeRequestObservations().filter(request => request.method === 'POST'
        && request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1)).toHaveLength(1);
      await waitFor(async () => {
        const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
          headers: { Authorization: `Bearer ${actor.credentials.token}`,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
        });
        expect(response.status).toBe(200);
        const observed = AutomationV3RunListResponseSchema.parse(response.data).runs;
        expect(observed.length).toBeLessThanOrEqual(1);
        return observed.length === 1 && reviewRunHasChildSession(actor, observed[0]!.id, {
          parentSessionId: session.sessionId, machineId: machine.target.machineId, path: machine.workspaceDir,
        });
      }, { failFast: true, context: 'Reverse UI-hosted plugin effect starts one review Run' });
    } finally { await ui.close(); }
  }, 0);
});
