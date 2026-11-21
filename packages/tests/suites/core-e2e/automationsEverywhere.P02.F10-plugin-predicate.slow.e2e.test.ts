import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { applyTrustedLocalPluginFixture, reloadTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalQueueListResultV1Schema, ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1 } from '../../../protocol/src/automations/automationActionOccurrenceV1';

describe('Automations everywhere: input-sensitive plugin effects', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('AE.P02.F10-plugin-predicate offers effects and starts preview 0 / save 1 / read 0 / effect 1 Runs', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-plugin-predicate-'));
    let failTerminalCallback = false;
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true,
      beforeHttpRequest: request => {
        if (failTerminalCallback && request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1) {
          throw new Error('Fixture terminal observation transport failed');
        }
      },
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const context = { defaultSessionId: session.sessionId, externalActionTarget: { kind: 'machine' as const,
      machineId: machine.target.machineId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    const runs = async (automationId: string) => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
        headers: { Authorization: `Bearer ${actor.credentials.token}`,
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      });
      expect(response.status).toBe(200);
      return AutomationV3RunListResponseSchema.parse(response.data).runs;
    };
    // The Home-owned path works before any plugin is installed; raw HTTP remains D6's explicit bypass.
    const homeLinked = await actor.executeAsPerson('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the completed Home effect.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } }, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: ['account.name.set'] },
    }, context);
    expect(homeLinked.ok, JSON.stringify(homeLinked)).toBe(true);
    if (!homeLinked.ok) throw new Error('Home effect trigger refused');
    const homeTrigger = WorkflowTriggerWriteResultV1Schema.parse(homeLinked.result);
    fixture.takeRequestObservations();
    const privateHomeName = 'private-home-name-not-for-action-evidence';
    expect(await actor.executeAsPerson('account.name.set', { name: privateHomeName }, context))
      .toMatchObject({ ok: true, result: { name: privateHomeName, firstName: privateHomeName, lastName: null } });
    const homeOccurrences = fixture.readActionOccurrences().filter(value => value.evidence.actionId === 'account.name.set');
    expect(homeOccurrences).toHaveLength(1);
    expect(homeOccurrences[0]).toMatchObject({ evidence: { phase: 'after', status: 'succeeded' } });
    expect(JSON.stringify(homeOccurrences)).not.toContain(privateHomeName);
    await waitFor(async () => {
      const observed = await runs(homeTrigger.set.automationId);
      expect(observed.length).toBeLessThanOrEqual(1);
      return observed.length === 1 && typeof observed[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Home effect starts one review Run before plugin installation' });
    fixture.takeRequestObservations();
    failTerminalCallback = true;
    const retainedHomeName = 'native-home-result-survives-observer-failure';
    expect(await actor.executeAsPerson('account.name.set', { name: retainedHomeName }, context))
      .toMatchObject({ ok: true, result: { name: retainedHomeName, firstName: retainedHomeName, lastName: null } });
    expect(fixture.takeRequestObservations().filter(request => request.method === 'POST'
      && request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1)).toEqual([
      { method: 'POST', path: AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, statusCode: 502 },
    ]);
    expect(await runs(homeTrigger.set.automationId)).toHaveLength(1);
    failTerminalCallback = false;
    const pluginId = 'acme.automation-predicate';
    const common = { title: 'Automation predicate fixture', dangerLevel: 'safe', scopes: ['global'],
      surfaces: ['cli', 'agent', 'mcp', 'plugin'], inputSchema: { type: 'object',
        properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false },
      run: (input: unknown) => input } as const;
    // Public authoring generates the manifest consumed by the installed loader.
    const authored = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
      setup: { ...common, readOnly: { op: 'eq', path: 'mode', value: 'preview' } },
      read: { ...common, readOnly: true }, effect: { ...common, readOnly: false },
    } });
    const pluginRoot = join(testDir, 'predicate-plugin');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: pluginId, version: '1.0.0', type: 'module' }));
    await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(authored.manifest));
    await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
      for (const id of ['setup', 'read', 'effect']) api.actions.register(id, input => input);
    }\n`);
    const plugin = { daemonPort: machine.daemon.state.httpPort, controlToken: machine.daemon.state.controlToken,
      pluginRoot, pluginId };
    await applyTrustedLocalPluginFixture({ ...plugin, interactionId: 'automation-predicate-install' });
    await reloadTrustedLocalPluginFixture({ ...plugin, changedPaths: ['daemon.mjs'] });
    const actionId = (localId: string) => formatQualifiedPluginActionId({ pluginId, localId });
    const discover = async (localId: string) => {
      const result = await actor.execute('action.spec.get', { id: actionId(localId) }, context);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    expect(await discover('setup')).toMatchObject({ ok: true, result: { actionSpec: { sideEffectClass: 'external' } } });
    expect(await discover('read')).toMatchObject({ ok: true, result: { actionSpec: { sideEffectClass: 'read' } } });
    expect(await discover('effect')).toMatchObject({ ok: true, result: { actionSpec: { sideEffectClass: 'external' } } });
    const addTrigger = (localId: string) => actor.executeAsPerson('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the plugin effect.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } }, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: [actionId(localId)] },
    }, context);
    // The trigger save owner is also the editor's hookability owner.
    expect(await addTrigger('read')).toMatchObject({ ok: false, errorCode: 'invalid_input' });
    const linkedSetup = await addTrigger('setup');
    const linkedEffect = await addTrigger('effect');
    expect(linkedSetup.ok, JSON.stringify(linkedSetup)).toBe(true);
    expect(linkedEffect.ok, JSON.stringify(linkedEffect)).toBe(true);
    if (!linkedSetup.ok || !linkedEffect.ok) throw new Error('Plugin effect trigger was refused');
    const setup = WorkflowTriggerWriteResultV1Schema.parse(linkedSetup.result);
    const effect = WorkflowTriggerWriteResultV1Schema.parse(linkedEffect.result);
    const invoke = async (localId: string, mode: string) => {
      expect(await actor.execute('action.invoke', { action: { pluginId, localId }, input: { mode } }, context))
        .toMatchObject({ ok: true, result: { mode } });
    };
    await invoke('setup', 'preview');
    expect(await runs(setup.set.automationId)).toEqual([]);
    await invoke('setup', 'save');
    await waitFor(async () => {
      const observed = await runs(setup.set.automationId);
      expect(observed.length).toBeLessThanOrEqual(1);
      return observed.length === 1 && typeof observed[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Plugin save starts its one review Run' });
    await invoke('read', 'save');
    expect(await runs(setup.set.automationId)).toHaveLength(1);
    expect(await runs(effect.set.automationId)).toEqual([]);
    await invoke('effect', 'save');
    await waitFor(async () => {
      const observed = await runs(effect.set.automationId);
      expect(observed.length).toBeLessThanOrEqual(1);
      return observed.length === 1 && typeof observed[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Ordinary plugin effect starts its one review Run' });
    expect(await runs(setup.set.automationId)).toHaveLength(1);
    fixture.takeRequestObservations();
    failTerminalCallback = true;
    // Only the observation HTTP boundary fails; the plugin's native effect/result remains real.
    await invoke('effect', 'save');
    expect(fixture.takeRequestObservations().filter(request => request.method === 'POST'
      && request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1)).toEqual([
      { method: 'POST', path: AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, statusCode: 502 },
    ]);
    expect(await runs(effect.set.automationId)).toHaveLength(1);
  }, 0);

  it('retains one safe contributed private settlement through deferred approval and approved replay', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-plugin-private-replay-'));
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const pluginId = 'acme.automation-private-replay';
    const localId = 'apply';
    const actionId = formatQualifiedPluginActionId({ pluginId, localId });
    const authored = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' }, actions: {
      apply: { title: 'Apply private fixture', dangerLevel: 'safe', readOnly: { op: 'eq', path: 'mode', value: 'preview' }, scopes: ['global'],
        surfaces: ['cli', 'ui'], inputSchema: { type: 'object', properties: { mode: { type: 'string' }, secret: { type: 'string' } },
          required: ['mode', 'secret'], additionalProperties: false },
        run: async () => ({ applied: true }) },
      live: { title: 'Apply retained live fixture', dangerLevel: 'safe', readOnly: { op: 'eq', path: 'mode', value: 'preview' }, scopes: ['global'],
        surfaces: ['cli', 'ui'], approvalInputCustody: 'live_only', secretInputPaths: ['secret'],
        inputSchema: { type: 'object', properties: { mode: { type: 'string' }, secret: { type: 'string' } },
          required: ['mode', 'secret'], additionalProperties: false }, run: async () => ({ applied: true }) },
    } });
    const pluginRoot = join(testDir, 'private-plugin');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: pluginId, version: '1.0.0', type: 'module' }));
    await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(authored.manifest));
    const effectAuditPath = join(testDir, 'private-plugin-effect-audit.jsonl');
    // Installed readOnly predicates are closed manifest JSON, so a fixture
    // counter closure cannot reach their host evaluator. This in-process
    // diagnostic Session opens no debug server and changes no production owner.
    await writeFile(join(pluginRoot, 'daemon.mjs'), [
      "import { Session } from 'node:inspector'; import { appendFile } from 'node:fs/promises';",
      'export async function activate(api) {',
      ' const inspector = new Session(); inspector.connect();',
      ' const post = (method, params = {}) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));',
      " await post('Profiler.enable'); await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });",
      ' for (const id of ["apply", "live"]) api.actions.register(id, async () => {',
      "  const coverage = await post('Profiler.takePreciseCoverage');",
      "  const readOnlyEvaluations = coverage.result.flatMap(script => script.functions).filter(fn => fn.functionName === 'pluginActionDeclarationIsReadOnlyForInput').reduce((total, fn) => total + (fn.ranges[0]?.count ?? 0), 0);",
      `  await appendFile(${JSON.stringify(effectAuditPath)}, JSON.stringify({ id, readOnlyEvaluations }) + '\\n');`,
      '  return { applied: true }; });',
      '}',
    ].join('\n'));
    const effectAudit = async () => (await readFile(effectAuditPath, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { id: string; readOnlyEvaluations: number });
    const plugin = { daemonPort: machine.daemon.state.httpPort, controlToken: machine.daemon.state.controlToken,
      pluginRoot, pluginId };
    await applyTrustedLocalPluginFixture({ ...plugin, interactionId: 'automation-private-replay-install' });
    await reloadTrustedLocalPluginFixture({ ...plugin, changedPaths: ['daemon.mjs'] });
    const context = { defaultSessionId: session.sessionId, externalActionTarget: { kind: 'machine' as const,
      machineId: machine.target.machineId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    const linkEffect = (selectedActionId: string) => actor.executeAsPerson('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the completed effect.', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } }, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: [selectedActionId] },
    }, context);
    const linked = await linkEffect(actionId);
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error('Private plugin trigger refused');
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const requestId = 'private-plugin-original-request';
    const sentinel = 'private-plugin-secret-not-for-evidence-or-history';
    fixture.takeRequestObservations();
    const requested = await actor.execute('action.invoke', { action: { pluginId, localId }, input: { mode: 'save', secret: sentinel } }, {
      ...context, actionRequestId: requestId, authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } }),
    });
    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(fixture.readActionOccurrences()).toEqual([]);
    expect(JSON.stringify(requested)).not.toContain(sentinel);
    if (!requested.ok || !requested.result || typeof requested.result !== 'object'
      || !('artifactId' in requested.result) || typeof requested.result.artifactId !== 'string') {
      throw new Error('Private plugin did not retain ordinary approval');
    }
    const artifactId = requested.result.artifactId;
    const approved = await actor.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' });
    expect(approved).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(JSON.stringify(approved)).not.toContain(sentinel);
    expect(await actor.replayApprovedApprovalRequest(artifactId)).toMatchObject({ ok: true });
    expect(await effectAudit()).toEqual([{ id: 'apply', readOnlyEvaluations: 1 }]);
    const occurrences = fixture.readActionOccurrences().filter(value => value.evidence.actionId === actionId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ evidence: { requestId, phase: 'after', status: 'succeeded' },
      triggers: [{ automationId: saved.set.automationId, triggerId: saved.triggerId, triggerRevision: saved.triggerRevision }] });
    expect(JSON.stringify(occurrences)).not.toContain(sentinel);
    expect(fixture.takeRequestObservations().filter(request => request.method === 'POST'
      && request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1)).toHaveLength(1);
    await waitFor(async () => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
        headers: { Authorization: `Bearer ${actor.credentials.token}`,
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      });
      expect(response.status).toBe(200);
      const runs = AutomationV3RunListResponseSchema.parse(response.data).runs;
      expect(runs.length).toBeLessThanOrEqual(1);
      expect(JSON.stringify(runs)).not.toContain(sentinel);
      return runs.length === 1 && typeof runs[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Private plugin approved replay starts one safe review Run' });

    // This action explicitly requires the original live invocation. Its raw
    // secret never enters the persisted approval input or public history.
    const liveActionId = formatQualifiedPluginActionId({ pluginId, localId: 'live' });
    const liveLinked = await linkEffect(liveActionId);
    expect(liveLinked.ok, JSON.stringify(liveLinked)).toBe(true);
    if (!liveLinked.ok) throw new Error('Live plugin trigger refused');
    const liveSaved = WorkflowTriggerWriteResultV1Schema.parse(liveLinked.result);
    const liveRequestId = 'live-plugin-original-request';
    const liveSentinel = 'retained-live-secret-not-for-approval-history';
    fixture.takeRequestObservations();
    let completed = false;
    let failure: unknown;
    const pending = actor.execute('action.invoke', { action: { pluginId, localId: 'live' }, input: { mode: 'save', secret: liveSentinel } }, {
      ...context, actionRequestId: liveRequestId, authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { [liveActionId]: { approvalRequiredSurfaces: ['cli'] } } }),
    });
    void pending.then(() => { completed = true; }, error => { failure = error; });
    let liveArtifactId: string | undefined;
    await waitFor(async () => {
      if (failure) throw failure;
      expect(completed, 'Live-only invocation must retain its raw operands until the person decides').toBe(false);
      const listed = await actor.execute('approval.request.list', { status: 'open', actionId: 'action.invoke' });
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      if (!listed.ok) return false;
      const item = ApprovalQueueListResultV1Schema.parse(listed.result).items[0];
      liveArtifactId = item?.artifactId;
      return liveArtifactId !== undefined;
    }, { failFast: true, context: 'Declared live-only plugin exposes its retained approval' });
    if (!liveArtifactId) throw new Error('Live plugin approval missing');
    const readLiveApproval = async () => {
      const read = await actor.execute('approval.request.get', { artifactId: liveArtifactId });
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (!read.ok) throw new Error('Live plugin approval cannot be read');
      return ApprovalRequestGetResultV1Schema.parse(read.result);
    };
    const open = await readLiveApproval();
    expect(open).toMatchObject({ request: { status: 'open', approvalInputCustody: 'live_only', qualifiedActionId: liveActionId } });
    expect(JSON.stringify(open)).not.toContain(liveSentinel);
    expect(fixture.readActionOccurrences()).toEqual([]);
    const liveDecision = await actor.executeAsPerson('approval.request.decide', { artifactId: liveArtifactId, decision: 'approve' });
    expect(liveDecision.ok, JSON.stringify(liveDecision)).toBe(true);
    expect(await pending).toMatchObject({ ok: true, result: { applied: true } });
    expect(await effectAudit()).toEqual([{ id: 'apply', readOnlyEvaluations: 1 }, { id: 'live', readOnlyEvaluations: 1 }]);
    const liveOccurrences = fixture.readActionOccurrences();
    expect(liveOccurrences).toHaveLength(1);
    expect(liveOccurrences[0]).toMatchObject({ evidence: { actionId: liveActionId, requestId: liveRequestId, phase: 'after', status: 'succeeded' },
      triggers: [{ automationId: liveSaved.set.automationId, triggerId: liveSaved.triggerId, triggerRevision: liveSaved.triggerRevision }] });
    expect(JSON.stringify([liveDecision, liveOccurrences, await readLiveApproval()])).not.toContain(liveSentinel);
    await waitFor(async () => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(liveSaved.set.automationId)}/runs`, {
        headers: { Authorization: `Bearer ${actor.credentials.token}`,
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      });
      expect(response.status).toBe(200);
      const observed = AutomationV3RunListResponseSchema.parse(response.data).runs;
      expect(observed.length).toBeLessThanOrEqual(1);
      expect(JSON.stringify(observed)).not.toContain(liveSentinel);
      return observed.length === 1 && typeof observed[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Retained live plugin starts one safe review Run' });
  }, 0);
});
