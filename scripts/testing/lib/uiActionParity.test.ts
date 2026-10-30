import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUiActionParity } from './uiActionParity.ts';

const specs = [
  { id: 'demo.edit', surfaces: { ui: true, agent: true, mcp: true, cli: false } },
  { id: 'settings.set', surfaces: { ui: true, agent: true, mcp: true, cli: true }, cli: { commands: [{ path: ['settings', 'set'] }] } },
];

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
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set', 'demo.edit', 'demo.missing', 'demo.missing', 'demo.edit']);
  assert.deepEqual(report.settings.map(site => site.key), ['density']);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action', 'unregistered_action']);
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
    ` },
  ], [{ ...specs[0], surfaces: { ui: true, agent: false } }, specs[1]], []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.edit']);
  assert.deepEqual(report.findings.map(site => site.code), ['agent_unavailable', 'agent_unavailable']);
  assert.equal(report.exclusions.length, 1);
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
