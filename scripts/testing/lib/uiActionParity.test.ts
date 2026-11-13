import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_SETTINGS_METADATA_V1 } from '../../../packages/protocol/src/actions/settings/builtInSettingsMetadata.ts';
import { SCREEN_CAPTURE_DELIVERY_ACTION_SPECS } from '../../../packages/protocol/src/actions/specs/screenCapture.ts';
import { listActionSpecs } from '../../../packages/protocol/src/actions/actionSpecs.ts';
import { collectUiActionParity, readUiActionParitySources } from './uiActionParity.ts';
import './uiActionParity.settings.test.ts';

const specs = [
  { id: 'demo.edit', surfaces: { ui: true, agent: true, mcp: true, cli: false } },
  { id: 'settings.set', surfaces: { ui: true, agent: true, mcp: true, cli: true }, cli: { commands: [{ path: ['settings', 'set'] }] } },
];

test('source discovery excludes test harnesses and composed fixtures while retaining product controls', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-parity-sources-'));
  try {
    const sources = join(root, 'apps/ui/sources');
    mkdirSync(sources, { recursive: true });
    for (const file of ['Controls.tsx', 'TestHarnessControls.tsx', 'quotaTestHarness.ts', 'boardActionsTestkit.ts',
      'catalog.testHarness.ts', 'origination.account.composed.fixture.ts', 'Controls.test.tsx']) {
      writeFileSync(join(sources, file), "executor.execute('demo.edit', {});");
    }
    assert.deepEqual(readUiActionParitySources(root).map(file => file.filePath).sort(), [
      'apps/ui/sources/Controls.tsx', 'apps/ui/sources/TestHarnessControls.tsx',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('current-context hook commands use opaque keys while arbitrary invoke calls remain Actions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Commands.tsx', content: `
    import { useCurrentUiContextLocalCommands as useCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
    import { useCurrentUiContextLocalCommands as useForeignCommands } from './foreignCommands';
    const commands = useCommands([]);
    commands.invoke('store.bots');
    const retained = commands;
    retained.invoke('store.bots');
    const invoke = retained.invoke;
    invoke('store.bots');
    commands.invoke('demo.edit');
    executor.invoke('demo.edit');
    executor.invoke('real.missing');
    const foreign = useForeignCommands([]);
    foreign.invoke('foreign.missing');
    function shadow(useCommands) {
      const commands = useCommands([]);
      commands.invoke('shadow.missing');
    }
    function shadowReceiver(commands) { commands.invoke('receiver.missing'); }
    function shadowDeclaration() {
      function useCommands() { return executor; }
      const commands = useCommands([]);
      commands.invoke('declared.missing');
    }
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), [
    'demo.edit', 'real.missing', 'foreign.missing', 'shadow.missing', 'receiver.missing', 'declared.missing',
  ]);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['unregistered_action', 'real.missing'],
    ['unregistered_action', 'foreign.missing'],
    ['unregistered_action', 'shadow.missing'],
    ['unregistered_action', 'receiver.missing'],
    ['unregistered_action', 'declared.missing'],
  ]);
});

test('declaration shadowing preserves typed local Action adapter argument positions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/ScopedCommands.tsx', content: `
    type ScopedActionId = 'demo.edit';
    function executeForScope(scope: unknown, actionId: ScopedActionId) {}
    executeForScope('workspace', 'demo.edit');
    executeForScope('workspace', 'adapter.missing');
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'adapter.missing']);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['unregistered_action', 'adapter.missing'],
  ]);
});

test('typed executor forwarding checks callers and still reports rewritten or redirected operands', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Forward.tsx', content: `
    const actions = useMountedActionExecution();
    const forward: typeof actions.execute = (actionId, input) => actions.execute(actionId, input);
    forward('demo.edit', {});
    forward('missing.action', {});
    forward(dynamicId, {});
    const rewrite: typeof actions.execute = (actionId, input) => actions.execute(otherId, input);
    const redirect: typeof actions.execute = (actionId, input) => otherActions.execute(actionId, input);
    const memo = React.useCallback<typeof actions.execute>((actionId, input) => actions.execute(actionId, input), []);
    memo('demo.edit', {});
    memo('memo.missing', {});
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'missing.action', 'demo.edit', 'memo.missing']);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['unregistered_action', 'missing.action'],
    ['dynamic_action', 'Identifier: dynamicId'],
    ['dynamic_action', 'Identifier: otherId'],
    ['dynamic_action', 'Identifier: actionId'],
    ['unregistered_action', 'memo.missing'],
  ]);
});

test('explicit Saved Secret repair requires Action admission while maintenance stays with its owner', () => {
  const content = `import { repairApprovedSavedSecretResourceEnvelopesBestEffort as repair } from '@/sync/ops/settings/savedSecretResourceOperations';
    repair(input);
    function local(repair) { repair(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/secrets/SavedSecretAccessEditor.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/settings/savedSecretResourceOperations.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_saved_secret_repair', 'repairApprovedSavedSecretResourceEnvelopesBestEffort'],
  ]);
});

test('native reveal and remembered Trust UI effects require Action admission', () => {
  const content = `import { invokeDesktopHost as native } from '@/utils/platform/desktopHost';
    import { rememberReviewedProjectEffect as remember } from '@/sync/api/account/apiProjectTrust';
    native('system_tasks_open_log_path', { path }); native('system_tasks_reveal_output_path', { path });
    native('read_only_status'); remember(scope, input);
    function local(native, remember) { native('system_tasks_open_log_path'); remember(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/workspaces/sync/Reveal.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/homeRuntimeActionDeps.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_desktop_window_write', 'system_tasks_open_log_path'],
    ['direct_desktop_window_write', 'system_tasks_reveal_output_path'],
    ['direct_project_trust_write', 'rememberReviewedProjectEffect'],
  ]);
});

test('native path drafts consume only the canonical signed-out execution owner', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/RuntimeControls.tsx', content: `
    import { invokeDesktopHost as native } from '@/utils/platform/desktopHost';
    import { useLocalRuntimeActionExecution as useRuntime } from '@/components/approvals/useLocalRuntimeActionExecution';
    const runtime = useRuntime();
    runtime.runSignedOutDraft(() => native('system_tasks_open_log_path', { path }));
    const fake = { runSignedOutDraft: callback => callback() };
    fake.runSignedOutDraft(() => native('system_tasks_open_log_path', { path }));
    function shadow(useRuntime) {
      const runtime = useRuntime();
      runtime.runSignedOutDraft(() => native('system_tasks_reveal_output_path', { path }));
    }
  ` }], specs, []);
  assert.deepEqual(report.findings.map(site => site.operation), ['system_tasks_open_log_path', 'system_tasks_reveal_output_path']);
});

test('runner restart UI effects require Action admission and preserve effect adapters', () => {
  const content = `import { restartSessionRunnerForProviderBindingChange as recover,
    restartSessionRunnerOnCurrentRuntime } from '@/sync/ops/sessionRunnerRestart';
    recover(input); restartSessionRunnerOnCurrentRuntime(input);
    function local(recover) { recover(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/sessions/composer/Controller.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_session_runner_restart', 'restartSessionRunnerForProviderBindingChange'],
    ['direct_session_runner_restart', 'restartSessionRunnerOnCurrentRuntime'],
  ]);
});

test('Environment navigation and shared placement controls enter agent-visible Actions', () => {
  const files = [
    'apps/ui/sources/components/projects/deployments/environmentNavigation.tsx',
    'apps/ui/sources/components/projects/deployments/EnvironmentNavigationViews.tsx',
    'apps/ui/sources/components/ui/navigation/useNavigationSurfacePlacement.ts',
    'apps/ui/sources/components/ui/navigation/NavigationPlacementCustomizer.tsx',
    'apps/ui/sources/components/navigation/mobile/chrome/bars/detailPhoneNavigation.tsx',
  ].map(filePath => ({ filePath, content: readFileSync(filePath, 'utf8') }));
  const report = collectUiActionParity(files, listActionSpecs(), BUILT_IN_SETTINGS_METADATA_V1, { sourceRoot: process.cwd() });
  assert.deepEqual(report.findings, []);
  for (const actionId of ['shell.column.set', 'settings.set']) {
    assert.ok(report.actions.some(site => site.actionId === actionId), actionId);
  }
});

test('recording UI mutations enter Actions while native adapters remain the effect owner', () => {
  const content = `import { pauseNativeRecording as pause, resumeNativeRecording, stopNativeRecording,
    writeNativeRecordingDocument } from '@/desktop/capture/nativeCapture';
    pause(7); resumeNativeRecording(7); stopNativeRecording(7); writeNativeRecordingDocument('movie', next, options);
    function local(pause) { pause(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/screenCapture/window/CaptureWindowRoute.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/screenCaptureNativeActions.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_desktop_window_write', 'pauseNativeRecording'],
    ['direct_desktop_window_write', 'resumeNativeRecording'],
    ['direct_desktop_window_write', 'stopNativeRecording'],
    ['direct_desktop_window_write', 'writeNativeRecordingDocument'],
  ]);
});

test('explicit pane and File view controls cannot call raw state writers', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/appShell/panes/mainColumn/PaneMainColumnControls.tsx', content:
      `const button = <Button onPress={() => main.setHidden(true)} />;` },
    { filePath: 'apps/ui/sources/components/appShell/panes/AppPaneScopeHost.tsx', content:
      `const keys = { 'panes.main.toggle': () => toggle(), 'panes.side.toggle': () => props.setSideVisible(true) };
       const terminal = { setVisible: visible => props.setHidden(!visible) };` },
    { filePath: 'apps/ui/sources/components/workspaces/files/details/WorkspaceFileDetailsView.tsx', content:
      `const onDisplayMode = mode => { patchFileView({ mode }); setDisplayMode(mode); };
       const onChangesScopeChange = changesScope => patchFileView({ changesScope });
       const menu = { toggleBlame: () => patchFileView({ blame: true }) };
       const terminal = { set: patch => { applyDisplayMode(patch.mode); patchFileView(patch); } };
       useEffect(() => patchFileView({ mode: 'file' }), []);
       const wrap = () => patchFileView({ wrap: true });` },
    { filePath: 'apps/ui/sources/components/media/Gallery.tsx', content:
      `const onDisplayMode = mode => setDisplayMode(mode);` },
  ], specs, []);
  assert.deepEqual(report.findings.filter(site => site.code === 'direct_view_control_write').map(site => site.operation), [
    'shell.column.set', 'shell.column.set', 'shell.column.set',
    'file.view.set', 'file.view.set', 'file.view.set', 'file.view.set',
  ]);
});

test('current pane and File view UI ingress reaches the Action executor', () => {
  const files = [
    'apps/ui/sources/components/appShell/panes/mainColumn/PaneMainColumnControls.tsx',
    'apps/ui/sources/components/appShell/panes/AppPaneScopeHost.tsx',
    'apps/ui/sources/components/appShell/panes/AppPaneScopeControls.tsx',
    'apps/ui/sources/components/workspaces/files/details/WorkspaceFileDetailsView.tsx',
  ].map(filePath => ({ filePath, content: readFileSync(new URL(`../../../${filePath}`, import.meta.url), 'utf8') }));
  const report = collectUiActionParity(files, specs, []);
  assert.deepEqual(report.findings.filter(site => site.code === 'direct_view_control_write'), []);
});

test('device-local message pin UI writes enter Actions while the canonical pin adapter owns persistence', () => {
  const content = `import { savePersistedSessionMessagePins as savePins } from '@/sync/domains/state/sessionMessagePinsPersistence';
    import * as pinStore from '@/sync/domains/state/sessionMessagePinsPersistence';
    savePins('session', pins, account); pinStore.savePersistedSessionMessagePins('session', pins, account);
    function local(savePins, pinStore) { savePins(); pinStore.savePersistedSessionMessagePins(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/sessions/transcript/Pin.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/sessionMessagePinsAction.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_message_pin_write', 'savePersistedSessionMessagePins'],
    ['direct_message_pin_write', 'savePersistedSessionMessagePins'],
  ]);
});

test('picker and message pin controls retain their literal Action discovery', () => {
  const ids = ['ui.prompts.picker.select', 'ui.prompts.picker.apply', 'session.messages.pins'];
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Picker.tsx',
    content: ids.map(id => `executor.execute('${id}', input);`).join('\n') }],
  ids.map(id => ({ id, surfaces: { ui: true, agent: true, mcp: true, cli: false } })), []);
  assert.deepEqual(report.actions.map(site => site.actionId), ids);
  assert.deepEqual(report.findings, []);
});

test('clipboard controls share Action admission except at the gesture-aware clipboard owner', () => {
  const safe = `import { setClipboardStringSafe as rawCopy } from '@/utils/ui/clipboard'; rawCopy('path');`;
  const native = `import * as Clipboard from 'expo-clipboard'; Clipboard.setStringAsync('selection');`;
  const named = `import { setStringAsync as copy } from 'expo-clipboard'; copy('link'); function unrelated(copy) { copy('local'); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/files/CopyPath.tsx', content: safe },
    { filePath: 'apps/ui/sources/components/files/useCopySelection.ts', content: native },
    { filePath: 'apps/ui/sources/components/git/CopyLink.tsx', content: named },
    { filePath: 'apps/ui/sources/utils/ui/clipboard.ts', content: native },
    { filePath: 'apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts', content: safe },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_clipboard_write', 'setClipboardStringSafe'],
    ['direct_clipboard_write', 'setStringAsync'],
    ['direct_clipboard_write', 'setStringAsync'],
  ]);
});

test('reviewed-mark record writes stay below the Action boundary, including local port aliases', () => {
  const content = `import { createScmReviewedMarksRecordPort as recordPort } from '@happier-dev/protocol/scm';
    const port = recordPort(input); const retained = port;
    retained.setReviewed(['ref'], true); port.setReviewedKeys(['key'], false); port.clear();
    port.read(); unrelated.setReviewedKeys(['key'], true);
    function local(recordPort) { const foreign = recordPort(input); foreign.clear(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/files/Marks.ts', content },
    { filePath: 'apps/ui/sources/sync/ops/scmDiffSummary/reviewedMarks.ts', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/scmActionDeps.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_reviewed_mark_write', 'setReviewed'], ['direct_reviewed_mark_write', 'setReviewedKeys'], ['direct_reviewed_mark_write', 'clear'],
    ['direct_reviewed_mark_write', 'setReviewed'], ['direct_reviewed_mark_write', 'setReviewedKeys'], ['direct_reviewed_mark_write', 'clear'],
  ]);
});

test('Capture still/frame/text Copy and reveal consume the shared declared Action capabilities', () => {
  const files = [
    'apps/ui/sources/components/screenCapture/window/CaptureWindowRoute.tsx',
    'apps/ui/sources/components/screenCapture/recording/VideoCaptureEditor.tsx',
    'apps/ui/sources/components/screenCapture/window/CaptureEditorShell.tsx',
    'apps/ui/sources/components/screenCapture/window/copyCaptureFromUi.ts',
    'apps/ui/sources/components/screenCapture/window/useCaptureWindowActions.ts',
    'apps/ui/sources/utils/platform/desktopWindowActionBridge.ts',
  ].map(filePath => ({ filePath, content: readFileSync(new URL(`../../../${filePath}`, import.meta.url), 'utf8') }));
  const ids = ['screenCapture.copy', 'screenCapture.showInFolder'];
  const report = collectUiActionParity(files, SCREEN_CAPTURE_DELIVERY_ACTION_SPECS, []);
  assert.deepEqual([...new Set(report.actions.map(site => site.actionId).filter(id => ids.includes(id)))].sort(), ids);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.exclusions, []);
});

test('Pending content edits and External Session follow controls enter their canonical Actions', () => {
  const pending = `import { sync as engine } from '@/sync/sync'; engine.updatePendingMessage('session', 'input', 'edit');
    engine.sendPendingMessageNow('session', {}); engine.deletePendingMessage('session', 'input');
    engine.deleteDiscardedPendingMessage('session', 'input'); engine.restoreDiscardedPendingMessage('session', 'input');
    unrelated.updatePendingMessage('input');`;
  const follow = `import { machineExternalSessionFollowPolicySet as writeFollow } from '@/sync/ops/machineExternalSessions'; writeFollow({ enabled: true });`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/sessions/composer/Editor.tsx', content: pending },
    { filePath: 'apps/ui/sources/sync/ops/actions/pendingEditAction.ts', content: pending },
    { filePath: 'apps/ui/sources/components/sessions/external/follow/Toggle.ts', content: follow },
    { filePath: 'apps/ui/sources/sync/ops/actions/externalSessionBrowseAction.ts', content: follow },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_pending_content_write', 'updatePendingMessage'],
    ['direct_pending_content_write', 'sendPendingMessageNow'],
    ['direct_pending_content_write', 'deletePendingMessage'],
    ['direct_pending_content_write', 'deleteDiscardedPendingMessage'],
    ['direct_pending_content_write', 'restoreDiscardedPendingMessage'],
    ['direct_external_follow_write', 'machineExternalSessionFollowPolicySet'],
  ]);
});

test('occurrence UI mutations must enter Action admission, while the transport owner remains callable', () => {
  const content = `import { sync as engine } from '@/sync/sync';
    engine.cancelAutomationRun('run'); engine.retryAutomationReplyHandoff('run');
    engine.deliverAutomationResultAgain({ runId: 'run', expectedRevision: 7 });
    unrelated.cancelAutomationRun('run');`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/workflows/run/Occurrence.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/occurrenceAction.ts', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/useOccurrenceAction.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_occurrence_write', 'cancelAutomationRun'],
    ['direct_occurrence_write', 'retryAutomationReplyHandoff'],
    ['direct_occurrence_write', 'deliverAutomationResultAgain'],
  ]);
});

test('occurrence transport imports and retained aliases cannot bypass Action admission', () => {
  const content = `import { mutateAutomationOccurrence as mutate } from '@/sync/api/automations/apiAutomations';
    import * as api from '@/sync/api/automations/apiAutomations';
    import { mutateAutomationOccurrence as unrelated } from './unrelated';
    const retained = mutate; const transport = api; const member = api.mutateAutomationOccurrence;
    mutate(credentials, id, input); retained(credentials, id, input);
    api.mutateAutomationOccurrence(credentials, id, input); transport.mutateAutomationOccurrence(credentials, id, input);
    member(credentials, id, input); unrelated(credentials, id, input);
    function local(mutate, api) { mutate(); api.mutateAutomationOccurrence(); const retained = mutate; retained(); }
    function shadow(retained, transport, member) { retained(); transport.mutateAutomationOccurrence(); member(); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/workflows/run/Occurrence.tsx', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/occurrenceAction.ts', content },
    { filePath: 'apps/ui/sources/sync/ops/actions/useOccurrenceAction.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), Array.from({ length: 5 }, () =>
    ['direct_occurrence_write', 'mutateAutomationOccurrence']));
});

test('rejects direct Project atmosphere writers from UI controls, including imported aliases', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/atmosphere/look/useProjectAtmosphereEditor.ts', content: `
      import { mutateProjectAtmosphereSetting as saveProject } from '../projectAtmosphereSettings';
      saveProject({ edit });
      mutateProjectAtmosphereSetting({ edit });
    ` },
    { filePath: 'apps/ui/sources/sync/ops/actions/settingsDeclarationAction.ts', content: `
      mutateProjectAtmosphereSetting({ edit });
    ` },
    { filePath: 'apps/ui/sources/components/atmosphere/projectAtmosphereSettings.ts', content: `
      export function mutateProjectAtmosphereSetting(context) { return context.rows.mutateOrganization(context); }
    ` },
    { filePath: 'apps/ui/sources/components/atmosphere/atmosphereSettings.ts', content: `
      export async function invokeAtmospherePictureOperation(operation, context) {
        return mutateProjectAtmosphereSetting({ rows: context.services.projectAccountRows });
      }
      function unadmittedNeighbor() { mutateProjectAtmosphereSetting({ edit }); }
    ` },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_settings_write', 'mutateProjectAtmosphereSetting'],
    ['direct_settings_write', 'mutateProjectAtmosphereSetting'],
    ['direct_settings_write', 'mutateProjectAtmosphereSetting'],
  ]);
  assert.equal(report.exclusions.length, 1);
});

test('explicit link handlers cannot bypass Action admission, including imported aliases and useCallback handlers', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/settings/Links.tsx', content: `
    import { openExternalUrl as rawOpen } from '@/utils/url/openExternalUrl';
    const open = React.useCallback(async () => { await rawOpen('https://example.test'); }, []);
    <Button onPress={open} />;
    <Button onPress={() => rawOpen('https://example.test/help')} />;
    async function authenticationContinuation() { await rawOpen(result.authorizationUrl); }
  ` }, { filePath: 'apps/ui/sources/components/settings/NativeLinks.tsx', content: `
    import { Linking as NativeLinks } from 'react-native';
    <Button onPress={async () => { if (await NativeLinks.canOpenURL('https://example.test')) await NativeLinks.openURL('https://example.test'); }} />;
  ` }], specs, []);
  assert.deepEqual(report.findings.map(finding => finding.code), ['direct_external_link', 'direct_external_link', 'direct_external_link']);
});

test('a declared setting does not bless a direct UI write that bypasses Action admission', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/settings/Example.tsx', content: `
    sync.applySettings({ density: 'compact' });
    sync.mutateAccountSettingsOnce({ mutate: raw => ({ settings: { ...raw, density: 'compact' } }) });
    const write = useSettingActionWriter(); write({ anchor: 'appearance.density' }, 'compact');
  ` }], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.findings.map(finding => finding.code), ['direct_settings_write', 'direct_settings_write']);
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set']);
});

test('exempts machine presentation state and validated Action forwarding only at their canonical owners', () => {
  const sources = [
    { filePath: 'apps/ui/sources/components/navigation/shell/appRail/AppRailMachines.tsx',
      content: `const apply = useApplyLocalSettings(); apply({ machinesRailSeenV1: next });` },
    { filePath: 'apps/ui/sources/components/machines/vitals/MachineVitalsRangeBar.tsx',
      content: `const [, setRange] = useLocalSettingMutable('machineVitalsRangeV1'); setRange('7d');` },
    { filePath: 'apps/ui/sources/components/machines/guard/activity/useGuardWayBack.ts',
      content: `createFrontDoorActionExecute()(item.actionId, item.input);` },
    { filePath: 'apps/ui/sources/activity/notifications/guardStopWarningLifecycle.ts',
      content: `createFrontDoorActionExecute()(command.actionId, command.payload);` },
  ];
  const report = collectUiActionParity(sources, specs, []);
  assert.deepEqual(report.findings, []);
  assert.equal(report.exclusions.length, 4);
  assert.ok(report.exclusions.every(site => site.reason.length > 0));
  const neighboring = collectUiActionParity(sources.map((source, index) => ({ ...source,
    filePath: `apps/ui/sources/components/machines/Unvalidated${index}.tsx` })), specs, []);
  assert.deepEqual(neighboring.findings.map(site => site.code), [
    'setting_unmapped', 'setting_unmapped', 'dynamic_action', 'dynamic_action',
  ]);
  const unknown = collectUiActionParity(sources.map(source => ({ ...source,
    content: source.content.replace('machinesRailSeenV1', 'unknownViewState')
      .replace('machineVitalsRangeV1', 'unknownRange').replace('item.actionId', 'other.actionId')
      .replace('command.actionId', 'other.actionId') })), specs, []);
  assert.equal(unknown.findings.length, 4);
});

test('applies the same device-local exemptions to raw settings writes without exempting neighboring keys or owners', () => {
  const filePath = 'apps/ui/sources/components/machines/vitals/MachineVitalsRangeBar.tsx';
  const report = collectUiActionParity([
    { filePath, content: `
      sync.applyLocalSettings({ machineVitalsRangeV1: '7d' });
      sync.applyLocalSettings({ machineVitalsRangeV1: '24h', unknownRange: true });
      sync.applySettings({ machineVitalsRangeV1: '7d' });
    ` },
    { filePath: 'apps/ui/sources/components/machines/Other.tsx',
      content: `sync.applyLocalSettings({ machineVitalsRangeV1: '7d' });` },
  ], specs, []);
  assert.deepEqual(report.exclusions.map(site => site.filePath), [filePath, filePath]);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_settings_write', 'applyLocalSettings'],
    ['direct_settings_write', 'applySettings'],
    ['direct_settings_write', 'applyLocalSettings'],
  ]);
});

test('walks aliases, conditional dispatch, registrations and settings instead of a fixed operation inventory', () => {
  const report = collectUiActionParity([{
    filePath: 'apps/ui/sources/components/Example.tsx',
    content: `import { useSettingMutable as usePreference } from '@/sync/domains/state/storage';
      const [value, setValue] = usePreference('density');
      setValue('compact');
      executor.execute(flag ? 'demo.edit' : 'demo.missing', {});
      executor.execute({ actionId: 'demo.missing', input: {} });
      const command = { actionId: 'demo.edit' };
      // executor.execute('comment.ignored', {});
      const label = 'unrelated.label';`,
  }], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set', 'demo.edit', 'demo.missing', 'demo.missing']);
  assert.deepEqual(report.settings.map(site => site.key), ['density']);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action', 'unregistered_action']);
});

test('Action metadata and policy targets are data until passed to dispatch', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const descriptor = { actionId: 'demo.edit' };
    writePolicy({ actionId: 'demo.edit', change: 'ask' });
    function describe() { return { actionId: 'demo.edit' }; }
    executor.execute(descriptor.actionId, {});
    executor.execute({ actionId: 'demo.missing', input: {} });
    const request = { actionId: 'demo.missing', input: {} };
    executor.execute(request);
    registerSurfaceAction({ actionId: 'demo.edit' });
    defineAction({ id: 'demo.edit' });
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.missing', 'demo.edit', 'demo.edit']);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['unregistered_action', 'demo.missing'], ['unregistered_action', 'demo.missing'],
  ]);
});

test('focused scans resolve first-party UI imports without scanning unrelated entry points', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-parity-imports-'));
  try {
    const sources = join(root, 'apps/ui/sources');
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, 'actionIds.ts'), `export const EDIT_ACTION_ID = 'demo.edit'; executor.execute('unrelated.missing', {});`);
    const report = collectUiActionParity([{ filePath: 'apps/ui/sources/Entry.tsx', content: `
      import { EDIT_ACTION_ID } from './actionIds';
      executor.execute(EDIT_ACTION_ID, {});
    ` }], specs, [], { sourceRoot: root });
    assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit']);
    assert.deepEqual(report.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finite record keys and immutable indexed maps keep all possible Actions visible', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    type Inputs = Readonly<{ 'demo.edit': unknown; 'demo.missing': unknown }>;
    function run<T extends keyof Inputs>(actionId: T) { executor.execute(actionId, {}); }
    const BY_OPERATION = { edit: 'demo.edit', missing: 'demo.missing' } as const;
    function mapped(operation: string) { executor.execute(BY_OPERATION[operation], {}); }
    const open = { edit: 'demo.edit', ...fetchOperations() } as const;
    function unknown(operation: string) { executor.execute(open[operation], {}); }
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.edit', 'demo.missing']);
  assert.deepEqual(report.findings.map(site => site.code), ['unregistered_action', 'unregistered_action', 'dynamic_action']);
});

test('readonly for-of rows and entries resolve their actual Action operands', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const controls: ReadonlyArray<Readonly<{ id: string }>> = [{ id: 'demo.edit' }, { id: 'demo.missing' }];
    for (const control of controls) executor.execute(control.id, {});
    for (const [index, control] of controls.entries()) executor.execute(control.id, {});
    const mutable = [{ id: 'demo.edit' }];
    for (const control of mutable) executor.execute(control.id, {});
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.edit', 'demo.missing']);
  assert.deepEqual(report.findings.map(site => site.code), ['unregistered_action', 'unregistered_action', 'dynamic_action']);
});

test('composed owner families resolve qualified type queries and Object.values spreads', () => {
  const report = collectUiActionParity([
    { filePath: 'packages/protocol/src/actions/actionIdsFixture.ts', content: `
      export const FAMILIES = { core: ['demo.edit', 'demo.missing'] as const } as const;
      const READS = { read: 'demo.edit' } as const;
      export const FILES = [...Object.values(READS), 'demo.missing'] as const;
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import { FAMILIES, FILES } from '@happier-dev/protocol/actions/actionIdsFixture';
      type CoreActionId = typeof FAMILIES.core[number];
      type FileActionId = typeof FILES[number];
      function core(actionId: CoreActionId) { executor.execute(actionId, {}); }
      function files(actionId: FileActionId) { executor.execute(actionId, {}); }
    ` },
  ], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.edit', 'demo.missing']);
  assert.deepEqual(report.findings.map(site => site.code), ['unregistered_action', 'unregistered_action']);
});

test('audited forwarding exemptions retain finite capability checks and unknown siblings', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts', content: `
    function forward(actionId: string) { executor.execute(actionId, {}); }
    function finite(actionId: 'demo.missing') { executor.execute(actionId, {}); }
    function added(futureActionId: string) { executor.execute(futureActionId, {}); }
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.missing']);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['unregistered_action', 'demo.missing'], ['dynamic_action', 'Identifier: futureActionId'],
  ]);
  assert.equal(report.exclusions.length, 1);
});

test('pairing bootstrap exemption does not expose the credential through another UI entry', () => {
  const content = `executor.execute('machines.pairing.create', {});`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/hooks/auth/usePairingSession.ts', content },
    { filePath: 'apps/ui/sources/components/Unreviewed.tsx', content },
  ], [{ id: 'machines.pairing.create', surfaces: { ui: true, agent: false } }], []);
  assert.deepEqual(report.findings.map(site => [site.filePath, site.code]), [
    ['apps/ui/sources/components/Unreviewed.tsx', 'agent_unavailable'],
  ]);
  assert.equal(report.exclusions.length, 1);
});

test('rejects hidden agent/MCP and undeclared CLI commands without requiring CLI for client-only Actions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `invoke('demo.edit', {}); execute('demo.cli', {});` }], [
    { ...specs[0], surfaces: { ui: true, agent: false, mcp: false, cli: false } },
    { id: 'demo.cli', surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  ], [], { cliIds: new Set() });
  assert.deepEqual(report.findings.map(finding => finding.code), ['agent_unavailable', 'cli_command_missing']);
});

test('honours documented spec-owner exclusions without hiding other unavailable Actions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `execute('demo.pluginRequest', {}); execute('demo.hidden', {});` }], [
    { id: 'demo.pluginRequest', surfaces: { ui: true, agent: false, mcp: false } },
    { id: 'demo.hidden', surfaces: { ui: true, agent: false, mcp: false } },
  ], [], { agentExclusionReasons: new Map([['demo.pluginRequest', 'Host-stamped plugin provenance; not a user UI operation']]) });
  assert.deepEqual(report.findings.map(finding => finding.operation), ['demo.hidden']);
  assert.deepEqual(report.exclusions.map(site => site.reason), ['Host-stamped plugin provenance; not a user UI operation']);
});

test('does not count declaration reads as effects; unknown settings and unresolved dynamic ids stay visible', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `getActionSpec('demo.edit'); executor.execute(untypedId, {});
      const [, update] = useLocalSettingMutable('newPreference'); update(true);
      const apply = useApplySettings(); apply({ mystery: true });` }], specs, []);
  assert.equal(report.actions.length, 0);
  assert.deepEqual(report.findings.map(finding => finding.code), [
    'dynamic_action', 'setting_unmapped', 'setting_unmapped',
  ]);
});

test('pre-authentication bootstrap is excluded by its documented surface, not arbitrary Action ids', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/onboarding/preAuth/Example.tsx', content: `executor.execute('bootstrap.signIn', {});` },
    { filePath: 'apps/ui/sources/embed/Example.tsx', content: `executor.execute('composer.attachments.pick', {});` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `executor.execute('composer.attachments.pick', {});` },
  ], specs, []);
  assert.equal(report.actions.length, 1);
  assert.equal(report.exclusions.length, 2);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action']);
});

test('resolves constants in their lexical scope and walks machine dispatch argument positions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const ACTION_ID = 'demo.edit';
    function first() { executor.execute(ACTION_ID, {}); }
    function second() { const ACTION_ID = 'demo.missing'; executor.execute(ACTION_ID, {}); }
    registry.executeOnMachine(machineId, 'demo.edit', {});
    registerAction({ id: 'demo.edit' });
    const presentationCommand = { id: 'demo.edit', action: () => router.push('/settings') };
    const schema = { actionId: z.string() };
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.edit', 'demo.edit']);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action']);
});

test('follows the real front-door callable and declared-setting writer rather than their local variable names', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    import { createFrontDoorActionExecute as makeExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
    const perform = makeExecutor(); perform('demo.missing', {});
    const commit = useSettingActionWriter(); commit({ anchor: 'appearance.missing' }, true);
    useAction('demo.missing', {});
  ` }], specs, []);
  assert.deepEqual(report.findings.map(finding => finding.code), [
    'unregistered_action', 'setting_unmapped', 'unregistered_action',
  ]);
});

test('accepts generic CLI invocation when the spec deliberately declares no friendly commands', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `executor.execute('demo.edit', {});` }], [{ ...specs[0],
    surfaces: { ui: true, agent: true, mcp: true, cli: true }, cli: { commands: [] },
  }], [], { cliIds: new Set(['demo.edit']), cliCommandIds: new Set() });
  assert.deepEqual(report.findings, []);
});

test('does not mistake read-only use of a mutable hook for a UI mutation', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `const [value] = useSettingMutable('notWritten');
      const [other, unusedSetter] = useLocalSettingMutable('alsoNotWritten');
      render(value, other);` }], specs, []);
  assert.deepEqual(report.settings, []);
  assert.deepEqual(report.findings, []);
});

test('does not misclassify navigation, RPC transports, read hooks or executor factories as Action invocations', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    navigation.dispatch(route); invoke(target, RPC_METHODS.START, input);
    useActionOperationSelector(readSnapshot); useActionOperation(address);
    const perform = createFrontDoorActionExecute(createDefaultActionExecutor(context));
    perform(unknownAction, {});
  ` }], specs, []);
  assert.deepEqual(report.findings.map(finding => finding.code), ['dynamic_action']);
});

test('resolves imported setting refs and semantic binding writes without allowing arbitrary read-only preferences', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/settings/example.ts', content: `
      export const EDIT_SETTING = { anchor: 'appearance.mode' };
      export const modeBinding = { scope: 'local', access: 'read_write',
        commit: (local, value, writeLocal) => writeLocal({ themePreference: value }) };
      defineSettingsPage({ pageId: 'appearance', sections: { look: { settings: { mode: { storage: modeBinding } } } } });
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import { EDIT_SETTING } from './settings/example';
      const commit = useSettingActionWriter(); commit(EDIT_SETTING, 'dark');
      const [, setTheme] = useLocalSettingMutable('themePreference'); setTheme('dark');
      const [, setLanguage] = useSettingMutable('preferredLanguage'); setLanguage('en');
      const [, setOther] = useSettingMutable('otherReadOnly'); setOther(true);
    ` },
  ], specs, [
    { anchor: 'appearance.mode', storage: { scope: 'local', access: 'read_write' } },
    { anchor: 'language.appLanguage', storage: { scope: 'account', key: 'preferredLanguage', access: 'read_only' } },
    { anchor: 'other.readOnly', storage: { scope: 'account', key: 'otherReadOnly', access: 'read_only' } },
  ]);
  assert.deepEqual(report.findings.map(finding => finding.operation), ['account:otherReadOnly']);
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set', 'settings.set']);
  assert.equal(report.exclusions.length, 1);
});

test('an unattached or agent-disabled semantic storage object cannot authorize a setting write', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const fake = { storage: { scope: 'local', access: 'read_write',
      commit: (local, value, writeLocal) => writeLocal({ unattached: value }) } };
    defineSettingsPage({ pageId: 'appearance', sections: { look: { settings: { privateMode: {
      storage: { scope: 'local', access: 'read_write', commit: (local, value, writeLocal) => writeLocal({ privateMode: value }) },
    } } } } });
    const [, setUnattached] = useLocalSettingMutable('unattached'); setUnattached(true);
    const [, setPrivate] = useLocalSettingMutable('privateMode'); setPrivate(true);
  ` }], specs, [{ anchor: 'appearance.privateMode', surfaces: { agent: false, mcp: false },
    storage: { scope: 'local', access: 'read_write' } }]);
  assert.deepEqual(report.findings.map(finding => finding.operation), ['local:unattached', 'local:privateMode']);
});

test('an Action payload may contain a domain-native actionId without registering a second Action', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `executor.execute('demo.edit', { actionId: 'domain.native_operation', input: {} });` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit']);
  assert.deepEqual(report.findings, []);
});

test('walks resolved conditional setting deltas and spreads instead of declaring known keys dynamic', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const apply = useApplySettings();
    const delta = flag ? { density: 'compact' } : { mystery: true };
    apply(delta);
    apply({ ...(flag ? { density: 'comfortable' } : {}), mystery: false });
    apply(current => ({ density: current.density === 'compact' ? 'comfortable' : 'compact' }));
  ` }], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.findings.map(finding => finding.operation), ['account:mystery', 'account:mystery']);
  assert.deepEqual(report.settings.map(site => site.key), ['density', 'mystery', 'density', 'mystery', 'density']);
});

test('consumes admitted semantic-owner deltas without treating a disabled declaration as writable', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const [, setChoice] = useSettingMutable('coupledChoice'); setChoice({ mode: 'compact' });
    const [, setPrivate] = useSettingMutable('privateChoice'); setPrivate(true);
  ` }], specs, [
    { anchor: 'appearance.choice', storage: { scope: 'account', access: 'read_write' } },
    { anchor: 'appearance.privateChoice', storage: { scope: 'account', access: 'read_write' }, surfaces: { agent: false } },
  ], { settingBindings: new Map([['account:coupledChoice', ['appearance.choice']], ['account:privateChoice', ['appearance.privateChoice']]]) });
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set']);
  assert.deepEqual(report.findings.map(site => site.operation), ['account:privateChoice']);
});

test('resolves imported const maps, typed union parameters and spec-family indexed types', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/family.ts', content: `
      export const IDS = ['demo.edit', 'demo.missing'] as const;
      export type FamilyId = typeof IDS[number];
      export const OPERATIONS = { edit: 'demo.edit', remove: 'demo.missing' } as const;
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import { OPERATIONS, type FamilyId } from '../family';
      function run(id: FamilyId, operation: keyof typeof OPERATIONS) {
        executor.execute(id, {});
        executor.execute(OPERATIONS[operation], {});
      }
      function selected(id: Exclude<FamilyId, 'demo.missing'>) { executor.execute(id, {}); }
      function preference(key: 'density' | 'mystery') {
        const [, update] = useSettingMutable(key); update(true);
      }
    ` },
  ], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.actions.map(site => site.actionId), [
    'demo.edit', 'demo.missing', 'demo.edit', 'demo.missing', 'demo.edit', 'settings.set',
  ]);
  assert.deepEqual(report.findings.map(site => site.operation), ['demo.missing', 'demo.missing', 'account:mystery']);
});

test('partial dynamic branches stay unresolved and object-shaped execute inputs are not Action ids', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    function run(unknownId: string) { executor.execute(flag ? 'demo.edit' : unknownId, {}); }
    function native(input: { action: 'demo.edit' }) { executor.execute(input); }
  ` }], specs, []);
  assert.deepEqual(report.findings.map(site => site.code), ['dynamic_action']);
  assert.equal(report.findings[0].line, 2);
  assert.deepEqual(report.actions, []);
});

test('generic Action family constraints retain every member and lexical shadowing', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/family.ts', content: `
      const IDS = ['demo.edit', 'demo.missing'] as const;
      export type MachinePresetActionIdV1 = typeof IDS[number];
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import type { MachinePresetActionIdV1 } from '../family';
      type T = 'demo.edit';
      function execute<T extends MachinePresetActionIdV1>(actionId: T) { executor.execute(actionId, {}); }
      function unknown<T extends string>(actionId: T) { executor.execute(actionId, {}); }
      function nested<T extends MachinePresetActionIdV1>() {
        function inner<T extends 'demo.edit'>(actionId: T) { executor.execute(actionId, {}); }
      }
    ` },
  ], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.edit']);
  assert.deepEqual(report.findings.map(site => site.code), ['unregistered_action', 'dynamic_action']);
  assert.equal(report.findings[0].operation, 'demo.missing');
});

test('parameter annotations win over same-named globals and finite request fields resolve', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const id = 'demo.edit';
    function unknown(id: string) { executor.execute(id, {}); }
    function known(id: 'demo.missing') { executor.execute(id, {}); }
    function request(input: Readonly<{ actionId: 'demo.edit' | 'demo.missing' }>) {
      executor.execute(input.actionId, {});
    }
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.missing', 'demo.edit', 'demo.missing']);
  assert.deepEqual(report.findings.map(site => site.code), ['dynamic_action', 'unregistered_action', 'unregistered_action']);
});

test('a settings updater preserves the previous snapshot while its explicit delta still needs an Action path', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const apply = useApplySettings();
    apply(current => ({ ...current, density: 'compact', mystery: true }));
    const unproven = fetchDelta(); apply({ ...unproven, density: 'comfortable' });
  ` }], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.settings.map(site => site.key), ['density', 'mystery', 'density']);
  assert.deepEqual(report.findings.map(site => site.code), ['setting_unmapped', 'dynamic_setting']);
});

test('a canonical ActionId forwarding parameter is transport evidence; concrete callers still need parity', () => {
  const report = collectUiActionParity([
    { filePath: 'packages/protocol/src/actions/actionIds.ts', content: `
      const FAMILIES = { core: ['demo.edit', 'settings.set'] as const } as const;
      type Family = (typeof FAMILIES)[keyof typeof FAMILIES][number];
      const ACTION_IDS: readonly Family[] = Object.freeze(Object.values(FAMILIES).flat());
      export type ActionId = typeof ACTION_IDS[number];
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
      function invoke(id: ActionId) { executor.execute(id, {}); }
      invoke('demo.edit');
      function selected(id: 'demo.edit') { executor.execute(id, {}); }
      function callRequestAction(params: Readonly<{ actionId: ActionId; input: unknown }>) {
        executor.execute(params.actionId, params.input);
      }
      callRequestAction({ actionId: 'demo.edit', input: {} });
    ` },
  ], [{ ...specs[0], surfaces: { ui: true, agent: false } }, specs[1]], []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.edit', 'demo.edit']);
  assert.deepEqual(report.findings.map(site => site.code), ['agent_unavailable', 'agent_unavailable', 'agent_unavailable']);
  assert.equal(report.exclusions.length, 2);
});

test('local command request ids remain with their UI owner while its Action effects are scanned', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/sessionCommands.ts', content: `
      export type SessionActionId = 'ui.session.rename';
      export function executeSessionAction(params: Readonly<{ actionId: SessionActionId; input: unknown }>) {
        executor.execute('demo.edit', params.input);
      }
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import { executeSessionAction } from '../sessionCommands';
      executeSessionAction({ actionId: 'ui.session.rename', input: { title: 'Next' } });
    ` },
  ], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit']);
  assert.deepEqual(report.findings, []);
});

test('resolved RPC constants retain their transport provenance even when they share an Action id', () => {
  const report = collectUiActionParity([
    { filePath: 'packages/protocol/src/rpc/methods.ts', content: `export const RPC_METHODS = { READ: 'demo.edit', NATIVE: 'native.rpc' } as const;` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import { RPC_METHODS as methods } from '@happier-dev/protocol/rpc/methods';
      machine.invoke(methods.NATIVE, {}); machine.invoke(methods.READ, {});
      throwUnsupportedResponse(methods.READ);
      executor.execute(methods.READ, {});
    ` },
  ], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit']);
  assert.deepEqual(report.findings, []);
});

test('resolves lexical page aliases and finite indexed setting refs without admitting read-only rows', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const PAGE = defineSettingsPage({ pageId: 'appearance', sections: {} });
    function preferences(key: 'density' | 'locked') {
      const settings = PAGE.settings;
      const write = useSettingActionWriter();
      write(settings.density, 'compact');
      write(settings[key], true);
    }
  ` }], specs, [
    { anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } },
    { anchor: 'appearance.locked', storage: { scope: 'account', key: 'locked', access: 'read_only' } },
  ]);
  assert.deepEqual(report.settings.map(site => site.key), ['appearance.density', 'appearance.density', 'appearance.locked']);
  assert.deepEqual(report.findings.map(site => site.operation), ['appearance.locked']);
});

test('an Action factory inside a domain callback does not turn the callback operand into an Action id', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const send = React.useCallback((message: string) => {
      const perform = createFrontDoorActionExecute();
      return perform('demo.edit', { message });
    }, []);
    send('ordinary message');
    const choose = React.useCallback((value: null) => createFrontDoorActionExecute()('demo.edit', { value }), []);
    choose(null);
    const perform = React.useMemo(() => createFrontDoorActionExecute(), []);
    perform('demo.missing', {});
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.edit', 'demo.missing']);
  assert.deepEqual(report.findings.map(site => site.operation), ['demo.missing']);
});

test('finite const-list callback operands resolve Actions and setting refs from their actual rows', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const PAGE = defineSettingsPage({ pageId: 'appearance', sections: {} });
    const rows = [
      { id: 'demo.edit', setting: PAGE.settings.density },
      { id: 'demo.missing', setting: PAGE.settings.locked },
    ] as const;
    const write = useSettingActionWriter();
    rows.map(row => {
      selectedIds.has(row.id); selectedIds.includes(row.id); getEffectiveBindings(row.id, {});
      executor.execute(row.id, {}); write(row.setting, true);
    });
    mutate('demo.edit', {}); prepare('demo.edit', {}); read('demo.edit', {});
    const unknown = [...fetchRows(), { id: 'demo.edit' }];
    unknown.map(row => executor.execute(row.id, {}));
    const mutable = [{ id: 'demo.edit' }]; mutable.push(fetchRow());
    mutable.map(row => executor.execute(row.id, {}));
  ` }], specs, [
    { anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } },
    { anchor: 'appearance.locked', storage: { scope: 'account', key: 'locked', access: 'read_only' } },
  ]);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'settings.set', 'demo.edit', 'demo.edit', 'demo.edit']);
  assert.deepEqual(report.settings.map(site => site.key), ['appearance.density', 'appearance.locked']);
  assert.deepEqual(report.findings.map(site => site.code), ['unregistered_action', 'setting_unmapped', 'dynamic_action', 'dynamic_action']);
});


test('native window preference writes enter Settings Actions while the native binding owns transport', () => {
  const content = `import { setDesktopNativeTitleBar as applyFrame } from '@/utils/platform/desktopWindowBridge';
    applyFrame(true); function unrelated(applyFrame) { applyFrame(false); }`;
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/settings/desktop/DesktopWindowChromeSetting.tsx', content },
    { filePath: 'apps/ui/sources/components/settings/desktop/desktopWindowChromeBinding.ts', content },
  ], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_desktop_window_write', 'setDesktopNativeTitleBar'],
  ]);
});


test('the mounted native title bar setting enters its real declared Settings Action binding', () => {
  const files = [
    'apps/ui/sources/components/settings/desktop/DesktopWindowChromeSetting.tsx',
    'apps/ui/sources/components/settings/desktop/desktopSettings.ts',
    'apps/ui/sources/components/settings/desktop/desktopWindowChromeBinding.ts',
  ].map(filePath => ({ filePath, content: readFileSync(filePath, 'utf8') }));
  const report = collectUiActionParity(files, specs, BUILT_IN_SETTINGS_METADATA_V1);
  assert.deepEqual(report.findings, []);
  assert.ok(report.settings.some(site => site.key === 'desktop.nativeTitleBar'));
  assert.ok(report.actions.some(site => site.actionId === 'settings.set'));
});


test('external links in action descriptors and returned row handlers retain Action admission', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Outcome.tsx', content: `
    import { openExternalUrl } from '@/utils/url/openExternalUrl';
    const openHelp = () => { void openExternalUrl('https://help.test'); };
    const linkOpener = (link) => { switch (link.kind) {
      case 'pullRequest': return () => void openExternalUrl(link.url);
    } };
    function Outcome({ row, grantUrl }) {
      const onPress = row.session ? () => navigate(row.session) : row.opens ? linkOpener(row.opens) : undefined;
      return <><Card action={{ onPress: () => { void openExternalUrl(grantUrl); } }} />
        <Disclosure model={{ learnMore: { onPress: openHelp } }} />
        <Item {...(onPress ? { onPress } : {})} /></>;
    }
  ` }], specs, []);
  assert.deepEqual(report.findings.map(site => site.code), [
    'direct_external_link', 'direct_external_link', 'direct_external_link',
  ]);
});
