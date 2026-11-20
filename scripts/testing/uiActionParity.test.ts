import assert from 'node:assert/strict';
import test from 'node:test';
import { readCurrentActionDispatchParity, readCurrentUiActionParity } from './validateUiActionParity.ts';
import { listActionSpecsForCatalogSurface } from '../../packages/protocol/src/actions/actionCatalog.ts';
import { ACTION_ID_FAMILIES_V1, MACHINE_LIST_ACTION_ID_V1, isWorkflowRunActionIdV1 } from '../../packages/protocol/src/actions/actionIds.ts';
import { listActionSpecs } from '../../packages/protocol/src/actions/actionSpecs.ts';
import { PROJECT_SOURCE_ACTION_SPECS_V1 } from '../../packages/protocol/src/actions/specs/projectSources.ts';
import { PROJECT_CONTEXT_ACTION_SPECS } from '../../packages/protocol/src/actions/specs/projects.ts';
import { PROJECT_READINESS_ACTION_SPECS_V1 } from '../../packages/protocol/src/actions/specs/projectReadiness.ts';
import { MACHINE_PRESET_HTTP_ACTION_IDS_V1 } from '../../packages/protocol/src/machines/managed/machinePresetActionIdsV1.ts';
import { SCM_WORKTREE_REMOVE_ACTION_ID_V1 } from '../../packages/protocol/src/actions/scmActionIdsV1.ts';
import { MACHINE_SERVICE_LOGS_READ_ACTION_ID } from '../../packages/protocol/src/local/services/actionIdsV1.ts';
import { MachineGuardActivityWayBackV1Schema } from '../../packages/protocol/src/machines/guard/activityV1.ts';
import { buildGuardStopWarningPushDataV1, readGuardStopWarningPushActionV1 } from '../../packages/protocol/src/activity/webhookPayload.ts';

let uiReport: ReturnType<typeof readCurrentUiActionParity> | undefined;
const report = () => uiReport ??= readCurrentUiActionParity();

test('Team and Project Setup producers reach dispatch on every declared surface', context => {
  // Select the program's producers, rather than copying the historical audit's
  // reused Action inventory. In particular, project_sources also contains the
  // separately owned Starter producer, so consume the Source producer itself.
  const ids = new Set<string>([
    ...PROJECT_SOURCE_ACTION_SPECS_V1.map(spec => spec.id),
    ...PROJECT_CONTEXT_ACTION_SPECS.map(spec => spec.id),
    ...PROJECT_READINESS_ACTION_SPECS_V1.map(spec => spec.id),
    ...MACHINE_PRESET_HTTP_ACTION_IDS_V1,
    MACHINE_LIST_ACTION_ID_V1,
    SCM_WORKTREE_REMOVE_ACTION_ID_V1,
    MACHINE_SERVICE_LOGS_READ_ACTION_ID,
    ...ACTION_ID_FAMILIES_V1.project_execution,
    ...ACTION_ID_FAMILIES_V1.project_definitions,
    ...ACTION_ID_FAMILIES_V1.project_workers,
    ...ACTION_ID_FAMILIES_V1.operation_output,
    ...ACTION_ID_FAMILIES_V1.teams,
    ...ACTION_ID_FAMILIES_V1.managed_machines,
    ...ACTION_ID_FAMILIES_V1.machine_agent_sign_in,
    ...ACTION_ID_FAMILIES_V1.machine_agent_install,
    ...ACTION_ID_FAMILIES_V1.machine_admin_access,
    ...ACTION_ID_FAMILIES_V1.machine_connection,
    ...ACTION_ID_FAMILIES_V1.scm_repository,
    ...ACTION_ID_FAMILIES_V1.workflows.filter(isWorkflowRunActionIdV1),
    ...ACTION_ID_FAMILIES_V1.plugin_collection_sharing,
    ...ACTION_ID_FAMILIES_V1.local_services_inventory,
    ...ACTION_ID_FAMILIES_V1.local_services_launcher,
    ...ACTION_ID_FAMILIES_V1.local_services_preview,
    ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
    ...ACTION_ID_FAMILIES_V1.local_services_actions,
  ]);
  const declared = listActionSpecs().filter(spec => ids.has(spec.id));
  assert.equal(declared.length, ids.size, 'each producer must publish its specs');
  // Build one complete graph. Other producers remain visible as advisory
  // findings rather than becoming exceptions in the dispatch algorithm.
  const dispatch = readCurrentActionDispatchParity();
  context.diagnostic(`Action dispatch: ${dispatch.canonicalSpecs} canonical specs, ${dispatch.mappedSpecs} mapped, `
    + `${ids.size} selected; ${dispatch.unmappedActionIds.length} unknown mappings remain in the full-catalog advisory`);
  assert.deepEqual(dispatch.findings.filter(finding => ids.has(finding.actionId)), []);
});

test('Check and Automation enabled switches use the shared trigger Action owner', () => {
  const paths = new Set([
    'apps/ui/sources/components/projects/deployments/ServiceCheckDetail.tsx',
    'apps/ui/sources/components/automations/list/AutomationListGroup.tsx',
  ]);
  assert.deepEqual(report().findings.filter(site => paths.has(site.filePath)), []);
});

test('project, machine and workflow explicit links use Action admission', () => {
  const paths = new Set([
    'apps/ui/sources/components/projects/deployments/DeploymentDataCard.tsx',
    'apps/ui/sources/components/projects/deployments/DeploymentDatabasePage.tsx',
    'apps/ui/sources/components/projects/deployments/DeploymentPlatformTargetSheet.tsx',
    'apps/ui/sources/components/projects/deployments/DeploymentPlatformInspectState.tsx',
    'apps/ui/sources/components/projects/starters/NewAppScreen.tsx',
    'apps/ui/sources/components/machines/managed/RequesterDisclosure.tsx',
    'apps/ui/sources/components/workflows/run/OperationsOutcomeGroup.tsx',
  ]);
  assert.deepEqual(report().findings.filter(site => paths.has(site.filePath)), []);
});

test('deployment receipt links use agent-visible Action admission', () => {
  const receipt = 'apps/ui/sources/components/projects/deployments/DeploymentReceiptDetail.tsx';
  assert.deepEqual(report().findings.filter(site => site.filePath === receipt), []);
  for (const surface of ['agent', 'mcp', 'cli'] as const) {
    assert.ok(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === 'links.openExternal'));
  }
});

test('Bot template entry doors use the shared agent-visible Action opener', () => {
  const owns = (path: string) => path.startsWith('apps/ui/sources/components/sessions/bots/templates/')
    || path === 'apps/ui/sources/components/sessions/access/sessionShareSheetAdapter.tsx'
    || path === 'apps/ui/sources/components/sessions/access/SessionAccessEditor.tsx';
  assert.deepEqual(report().findings.filter(site => owns(site.filePath)), []);
  for (const actionId of ['prompt_doc.get', 'template.draft', 'template.open']) {
    assert.ok(report().actions.some(site => site.filePath.endsWith('/openBotTemplate.ts') && site.actionId === actionId), actionId);
    for (const surface of ['agent', 'mcp'] as const) {
      assert.ok(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === actionId));
    }
  }
});

test('Store controls and shared Add effects use agent-visible Action admission', () => {
  const owns = (path: string) => /^apps\/ui\/sources\/components\/(store\/|capabilities\/add\/|settings\/(mcpServers\/add\/|skills\/add\/|agents\/add\/))/.test(path)
    || path === 'apps/ui/sources/components/settings/plugins/PluginSettingsHomeScreen.tsx'
    || path === 'apps/ui/sources/components/settings/plugins/PluginUpdateReviewSettingsEntry.tsx';
  assert.deepEqual(report().findings.filter(site => owns(site.filePath)), []);
  const sites = report().actions.filter(site => owns(site.filePath));
  for (const actionId of ['mcp.servers.create', 'mcp.servers.import', 'skills.install', 'skills.create',
    'skills.rules.set', 'agents.acp.backends.installFromRegistry', 'machines.setup.apply', 'settings.set']) {
    assert.ok(sites.some(site => site.actionId === actionId), actionId);
  }
});

// Filesystem/source analysis belongs to the Node tooling harness, not a loaded UI worker.
test('maps current UI Action invocations, registrations and settings mutations to agent-visible canonical specs', () => {
  assert.ok(report().actions.length > 0);
  assert.ok(report().settings.length > 0);
  assert.deepEqual(report().findings.map(finding => `${finding.filePath}:${finding.line} ${finding.code}: ${finding.operation}`), []);
});

test('Artifact browser view controls use the declared settings Action ingress', () => {
  const browser = 'apps/ui/sources/components/artifacts/ArtifactsBrowserScreen.tsx';
  const owner = 'apps/ui/sources/components/ui/lists/collection/useCollectionDisplayOptions.ts';
  assert.deepEqual(report().findings.filter(site => site.filePath === browser || site.filePath === owner), []);
  assert.ok(report().settings.some(site => site.filePath === owner
    && site.scope === 'declaration' && site.key === 'appearance.collectionDisplay'));
});

test('machine resources UI intents map to canonical agent and MCP specs (AGW-1)', () => {
  // Same source walker and settings admission as the global check, not a second
  // inventory. Include the header terminal's existing admission adapter.
  const owns = (path: string) => /^apps\/ui\/sources\/(components\/machines\/|components\/approvals\/resourceProposal\/|sync\/domains\/machines\/(resources|storage|processes|guard)\/)/.test(path)
    || [
      'apps/ui/sources/hooks/machine/useMachineTerminalActionAdmission.ts',
      'apps/ui/sources/components/navigation/shell/appRail/AppRailMachines.tsx',
      'apps/ui/sources/components/navigation/shell/appRail/useMachinesRailSignal.ts',
      'apps/ui/sources/components/navigation/shell/sidebarFooter/SidebarMachinesPopoverContent.tsx',
      'apps/ui/sources/components/navigation/shell/sidebarFooter/MachinesPopoverAttention.tsx',
      'apps/ui/sources/activity/notifications/guardStopWarningLifecycle.ts',
    ].includes(path);
  const actions = report().actions.filter(site => owns(site.filePath));
  const findings = report().findings.filter(site => owns(site.filePath));
  assert.deepEqual(findings, []);
  for (const surface of ['agent', 'mcp'] as const) {
    const catalog = new Set<string>(listActionSpecsForCatalogSurface({ surface }).map(spec => spec.id));
    assert.deepEqual(actions.filter(site => !catalog.has(site.actionId)), []);
    // R44: local clipboard use is exempt; the agent equivalent already exists.
    assert.ok(catalog.has('clipboard.write'));
  }
  // Later additions at their actual dispatch owners: header Open terminal,
  // offline Notify consent, scan shortcuts, recipient Storage entries and Undo.
  for (const [suffix, actionId] of [
    ['hooks/machine/useMachineTerminalActionAdmission.ts', 'machines.terminal.open'],
    ['resources/useMachineOfflineAlert.ts', 'settings.set'],
    ['storage/machineRpc.ts', 'machines.storage.scan.start'],
    ['storage/machineRpc.ts', 'machines.storage.pile.set'],
    ['storage/machineRpc.ts', 'machines.storage.items.check'],
    ['storage/machineRpc.ts', 'machines.storage.trash.move'],
    ['storage/machineRpc.ts', 'machines.storage.trash.empty'],
    ['guard/machineGuardRpc.ts', 'machines.guard.activity.undo'],
    ['sidebarFooter/MachinesPopoverAttention.tsx', 'machines.guard.activity.undo'],
  ]) assert.ok(actions.some(site => site.filePath.endsWith(suffix) && site.actionId === actionId), `${suffix}: ${actionId}`);
  // These dispatchers forward closed owner-produced references. Check the real
  // push producer/reader so their canonical walker exclusions do not hide ids
  // absent from the agent or MCP catalog.
  for (const warning of [
    { topic: 'guard_stop_warning', machineId: 'machine', sessionId: 'session', rule: 'idle_sessions', stopAt: 300_000 },
    { topic: 'guard_stop_warning', machineId: 'machine', terminalId: 'terminal', terminalKey: 'shell', rule: 'idle_terminals', stopAt: 300_000 },
  ] as const) {
    const push = buildGuardStopWarningPushDataV1(warning);
    for (const action of ['keepRunning', 'stopNow'] as const) {
      const admitted = readGuardStopWarningPushActionV1(push, action, { serverId: 'home' });
      assert.ok(admitted);
      for (const surface of ['agent', 'mcp'] as const) {
        assert.ok(listActionSpecsForCatalogSurface({ surface }).some(spec => spec.id === admitted.actionId));
      }
    }
    assert.equal(readGuardStopWarningPushActionV1({ ...push, actions: { ...push.actions,
      stopNow: { actionId: 'machines.guard.unmappedIntent', input: {} } } }, 'stopNow', { serverId: 'home' }), null);
  }
  for (const actionId of ['machines.storage.trash.empty', 'machines.storage.unmappedIntent']) {
    assert.equal(MachineGuardActivityWayBackV1Schema.safeParse({ label: 'empty_now', actionId, input: {} }).success,
      actionId === 'machines.storage.trash.empty');
  }
});
