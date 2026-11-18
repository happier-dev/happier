import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  createSessionFixture,
  createMachineFixture,
  renderHook,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { setSessionCapabilitySelectionItemV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const homes = createHomeGovernanceHarness();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<unknown>>(),
);
// Only the remote Machine RPC transport is substituted; P2's state owners, the model and the chip are real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: transport }),
);
await loadSyncSingletonForTests();
const { useNewSessionCapabilitiesChip, useExistingSessionCapabilitiesChip } =
  await import('./useSessionCapabilitiesChip');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
const { useReachMachines } = await import('@/sync/domains/capabilities/reach/useReachProjection');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useReachRulesLookup } = await import('@/sync/store/useReachRulesCatalog');
const { applyPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { loadPromptLibraryCatalogV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
const { PromptLibraryRecordV1Schema, PromptLibraryRowsListResponseV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
const { resolveSessionCapabilitiesV1 } = await import('@happier-dev/protocol/reach/resolveSessionCapabilitiesV1');
const { SessionCapabilitiesGetOutputV1Schema } = await import('@happier-dev/protocol/actions/specs/sessionCapabilities');
const { buildSessionCapabilitiesModel } = await import('./sessionCapabilitiesModel');
const { useSessionCapabilitiesDetail } = await import('./useSessionCapabilitiesDetail');
const { SessionCapabilitiesContent } = await import('./SessionCapabilitiesContent');
const { applyMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { McpServerCatalogV1Schema } = await import('@happier-dev/protocol/mcp/servers/serverRowsV1');
const { MetadataSchema } = await import('@happier-dev/session-core/state');
const { SessionSkillCatalogListResponseV1Schema } = await import('@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc');
const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { SessionCurrentProjectionRecordV1Schema} = await import('@happier-dev/protocol/sessions/listing/response');
const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1 } =
  await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
const { writeCapabilitySelectionApplyV1, clearCapabilitySelectionApplyV1 } =
  await import('@happier-dev/protocol/reach/sessionCapabilityMetadataV1');

const item = (kind: 'skill' | 'mcp_server', id: string, selected: boolean) => ({
  kind,
  id,
  name: id,
  selected,
  selectable: true,
  reason: selected ? 'rule_on' : 'no_rule',
  decidedBy: null,
  sessionOverride: null,
  ...(kind === 'mcp_server'
    ? { source: 'catalog' }
    : { state: selected ? 'delivered' : 'off' }),
});
const preview = {
  ok: true,
  machinePlatform: 'posix',
  mcp: {
    strictMode: false,
    items: [
      item('mcp_server', 'linear', true),
      item('mcp_server', 'github', false),
    ],
    detected: [],
  },
  skills: {
    items: [item('skill', 'review', true)],
    plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] },
  },
  applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
};
let serverId: string;
beforeEach(async () => {
  await homes.reset();
  installHomeGovernanceBoundaries(httpBoundary);
  await loadSyncSingletonForTests();
  serverId = await homes.addHome({
    name: 'Session Home',
    serverUrl: 'https://chip-capabilities.test',
    accountId: 'owner',
  });
  homes.answer(serverId, '/v1/account/encryption/currentness', {
    body: createPlainAccountEncryptionCurrentnessFixture(),
  });
  transport.mockReset();
  transport.mockResolvedValue(preview);
});
afterEach(async () => {
  standardCleanup();
  clearDaemonMergedProjectionCacheForTests();
  await homes.reset();
});

it('keeps the joined Project in capability approval context and refuses conflicting stamps', async () => {
  const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1, homeServerIdentityId: 'srv_chip_capabilities',
    canonicalServerUrl: 'https://chip-capabilities.test', revision: 1,
    endpoints: [{ kind: 'https', url: 'https://chip-capabilities.test' }] } });
  if (!home.serverIdentityId) throw new Error('Expected a qualified fixture Home');
  const credentials = await TokenStorage.getCredentialsForServerUrl('https://chip-capabilities.test', { serverId });
  if (!credentials) throw new Error('Expected the fixture Home credentials');
  await restoreConnectionToActiveServer(credentials);
  const scope = { serverId: home.serverIdentityId, accountId: 'owner' };
  getStorage().setState({ settingsScope: scope, profileScope: scope });
  applyProjectAccountRowsFixture(getStorage(), { workspaceRefs: [{ id: 'checkout', serverId: scope.serverId,
    machineId: 'machine', rootPath: '/repo', projectKey: 'joined-project', createdAtMs: 1 }] });
  const hook = await renderHook(({ projectId }: { projectId: string }) => useSessionCapabilitiesDetail(
    scope.serverId, true, () => {}, { metadata: { path: '/repo', host: 'MacBook', machineId: 'machine',
      workspaceId: 'checkout', projectId, flavor: 'codex' } },
    { view: null, selection: {}, state: 'resolving', readOnly: false }, 'MacBook'),
    { initialProps: { projectId: 'checkout' } });
  await vi.waitFor(() => expect(hook.getCurrent().detail.context).toMatchObject({ projectKey: 'joined-project', directory: '/repo' }));
  await hook.rerender({ projectId: 'unrelated-project' });
  expect(hook.getCurrent().detail.context).toBeUndefined();
});

it('composes the real rules lookup and sheet model without showing Off before the rules load', async () => {
  const scope = { serverId, accountId: 'owner' };
  const record = PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1, rules: [
    { id: 'review-everywhere', skillId: 'review', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
  ] } });
  if (record.key !== 'skill-rules') throw new Error('Invalid rule fixture');
  const context = { machineId: 'machine', machinePlatform: 'posix', directory: '/repo', projectKey: null, agentId: 'codex' } as const;
  const resolved = resolveSessionCapabilitiesV1({ context, selection: {}, agentAcceptsUserMcp: true, mcp: null,
    skills: { items: [{ skillId: 'review', name: 'Review' }], rules: record.value.rules } });
  const view = SessionCapabilitiesGetOutputV1Schema.parse({ ok: true, mcp: { items: [] }, skills: { items: resolved.skills.items,
    plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } }, pendingApply: { mcp: false, skills: false },
    applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } } });
  if (!view.ok) throw new Error('Invalid view fixture');
  const hook = await renderHook(() => {
    const lookup = useReachRulesLookup(scope);
    return buildSessionCapabilitiesModel({ view, selection: {}, context, state: 'ready', readOnly: false, rules: lookup.rules,
      mcpStatus: () => [], skillStatus: () => [], names: { machineName: id => id, projectName: id => id, agentName: id => id, agentNames: ids => ids, folderLabel: (_id, path) => path } });
  });
  expect(hook.getCurrent().groups[0]?.rows[0]).toMatchObject({ id: 'review', scope: '', dimmed: false });
  const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows: async () => PromptLibraryRowsListResponseV1Schema.parse({
    status: 'listed', rows: [{ key: record.key, revision: 0, content: { t: 'plain', v: record } }],
  }) });
  await act(async () => applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 0 }, true));
  expect(hook.getCurrent().groups[0]?.rows[0]).toMatchObject({ id: 'review', scope: 'Everywhere', dimmed: false });
});

it('indexes rules once for a sheet inventory and retains each selected rule array between reads', async () => {
  const scope = { serverId, accountId: 'owner' };
  const record = PromptLibraryRecordV1Schema.parse({ key: 'skill-rules', value: { v: 1,
    rules: Array.from({ length: 139 }, (_, index) => ({ id: `rule-${index}`, skillId: `skill-${index}`,
      target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 })),
  } });
  if (record.key !== 'skill-rules') throw new Error('Invalid rules fixture');
  const { applyPromptLibraryCatalogAcknowledgedRecord } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
  await act(() => applyPromptLibraryCatalogAcknowledgedRecord(scope, record, 1, true));
  const hook = await renderHook(() => useReachRulesLookup(scope));
  let visits = 0;
  for (const rule of record.value.rules) {
    const skillId = rule.skillId;
    Object.defineProperty(rule, 'skillId', { configurable: true, get() { visits++; return skillId; } });
  }
  const first = Array.from({ length: 139 }, (_, i) => hook.getCurrent().rules('skill', `skill-${i}`));
  const second = Array.from({ length: 139 }, (_, i) => hook.getCurrent().rules('skill', `skill-${i}`));
  expect(visits).toBeLessThanOrEqual(139 * 2);
  expect(first.every((rules, i) => rules === second[i])).toBe(true);
  expect(first[0]).toEqual([{ id: 'rule-0', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }]);
  expect(hook.getCurrent().rules('skill', 'missing')).toBe(hook.getCurrent().rules('skill', 'also-missing'));
});

it('puts the draft chip in the row reading its attached skills, and keeps an empty draft\'s chip in overflow', async () => {
  const render = async (selection: SessionCapabilitySelectionV1) => {
    const hook = await renderHook(() => useNewSessionCapabilitiesChip({
      draft: { machineId: 'machine', directory: '/repo', agentId: 'codex', targetServerId: serverId, selection, setSelection: () => {} },
      machineName: 'MacBook',
    }));
    const chip = hook.getCurrent().chip;
    await hook.unmount();
    return chip;
  };
  const { resolveAgentInputControlLines } = await import('@/components/sessions/agentInput/controls/resolveAgentInputControlLines');
  const lines = (chip: Awaited<ReturnType<typeof render>>) => resolveAgentInputControlLines({ controls: [{ ...chip.placement!,
    controlId: 'capabilities', line: 'primary', slot: 'chip', defaultPlacement: chip.placement!.defaultPlacement ?? 'overflow', pending: false }] });
  const attached = await render(setSessionCapabilitySelectionItemV1({}, 'skill', 'happier:hatch-pet', 'on'));
  expect(lines(attached).primary).toEqual([attached.placement!.id]);
  // Before any preview, the chip already names what the draft holds.
  const { t } = await import('@/text');
  expect(attached.collapsedContentPopover?.label).toBe(t('capabilities.session.counts', { skills: 1, mcp: 0 }));
  expect(transport).not.toHaveBeenCalled();
  const empty = await render({});
  expect(lines(empty).collapsed).toEqual([empty.placement!.id]);
});

it('binds the draft chip to the preview on intent and edits only the draft', async () => {
  const hook = await renderHook(() => {
    const [selection, setSelection] =
      React.useState<SessionCapabilitySelectionV1>({});
    return {
      selection,
      ...useNewSessionCapabilitiesChip({
        draft: {
          machineId: 'machine',
          directory: '/repo',
          agentId: 'codex',
          targetServerId: serverId,
          selection,
          setSelection,
        },
        machineName: 'MacBook',
      }),
    };
  });
  const chip = hook.getCurrent().chip;
  expect(chip.controlId).toBe('capabilities');
  // Closed and never hovered: no Machine preview.
  expect(transport).not.toHaveBeenCalled();
  await act(async () => {
    chip.onIntent?.();
  });
  await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('ready'));
  expect(hook.getCurrent().model.counts).toEqual({ skills: 1, mcp: 1 });
  expect(hook.getCurrent().chip.collapsedContentPopover?.label).toBe(
    hook.getCurrent().model.chipLabel,
  );
  // An Off server is offered by the add field; adding it changes the draft and nothing else.
  expect(hook.getCurrent().model.addItems.map((add) => add.id)).toEqual([
    'github',
  ]);
  expect(
    homes.requests.some((request) => request.path.includes('/sessions/')),
  ).toBe(false);
});

it('demands one preview for Session Skills and keeps opening its picker on that same owner', async () => {
  const sessionId = 'c123456789012345678901234';
  const owner = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'MacBook', machineId: 'machine',
    flavor: 'codex', startedBy: 'daemon', runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } } });
  if (!owner.ok) throw new Error('Invalid session owner fixture');
  const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
    active: true, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 1,
    metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
    dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
  for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
  homes.answer(serverId, 'POST /v1/artifacts/headers/read', { body: { artifacts: [] } });
  homes.answer(serverId, 'GET /v1/artifacts', { body: [] });
  getStorage().setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId, active: true,
    metadataLayoutVersion: 1, metadata: { path: '', host: '' }, ownerMetadataView: MetadataSchema.parse(
      projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: owner.ownerMetadata })) }) },
    sessionLocalStateScope: { serverId, accountId: 'owner' } });
  const { SessionSkillsPane } = await import('./SessionSkillsPane');
  const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
  const { t } = await import('@/text');
  let commands: ReturnType<typeof useCurrentUiContextComposedCommands> = [];
  function ObserveCommands() {
    commands = useCurrentUiContextComposedCommands();
    return null;
  }
  function MountedSkills() {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    return <CurrentUiContextCommandsProvider authority={binding ?? null}>
      <SessionSkillsPane sessionId={sessionId} serverId={serverId} /><ObserveCommands />
    </CurrentUiContextCommandsProvider>;
  }
  const screen = await renderScreen(<MountedSkills />);
  await vi.waitFor(() => expect(screen.findByType(SessionCapabilitiesContent)?.props.model.state).toBe('ready'));
  const calls = transport.mock.calls.length;
  expect(calls).toBe(1);
  const add = screen.findAll(node => node.props?.testID === 'session-skills:add' && typeof node.props?.onPress === 'function')[0];
  if (!add) throw new Error('Expected the Skills add picker');
  await act(async () => add.props.onPress());
  expect(transport.mock.calls.length).toBe(calls);
  expect(screen.findAll(node => node.props?.testID === 'session-skills:group:mcp')).toHaveLength(0);
  expect(homes.requests.filter(request => request.method === 'GET' && request.path === '/v1/artifacts')).toHaveLength(0);
  expect(commands.some(command => command.title === t('capabilities.session.sheet.removeLabel', { item: 'review' }))).toBe(true);
  await act(async () => getStorage().setState(current => ({ sessions: { ...current.sessions, [sessionId]: {
    ...current.sessions[sessionId]!, ownerMetadataView: MetadataSchema.parse({
      ...current.sessions[sessionId]!.ownerMetadataView,
      skillSelectionV1: setSessionCapabilitySelectionItemV1({}, 'skill', 'review', 'off').skills,
    }),
  } } })));
  await vi.waitFor(() => expect(screen.findByType(SessionCapabilitiesContent)?.props.model.groups[0]?.rows[0]?.action.kind).toBe('turn_on'));
  expect(commands.some(command => command.title === t('capabilities.session.sheet.removeLabel', { item: 'review' }))).toBe(false);
  expect(commands.some(command => command.title === t('capabilities.session.sheet.turnOnLabel', { item: 'review' }))).toBe(true);
  await act(async () => getStorage().setState({ settingsScope: { serverId, accountId: 'owner' } }));
  expect(commands.some(command => command.title === t('capabilities.skills.pane.allSkills'))).toBe(true);
  expect(screen.findByType(SessionCapabilitiesContent)?.props.skillDetails('review').onPress).toBeTypeOf('function');
  await act(async () => getStorage().setState({ settingsScope: { serverId: 'another-home', accountId: 'owner' } }));
  expect(screen.findAll(node => node.props?.testID === 'session-skills:open:skills')[0]?.props.disabled).toBe(true);
  expect(screen.findByType(SessionCapabilitiesContent)?.props.openUnavailableReason).toBe(t('common.unavailable'));
  expect(screen.findByType(SessionCapabilitiesContent)?.props.skillDetails('review').onPress).toBeUndefined();
  expect(commands.some(command => command.title === t('capabilities.skills.pane.allSkills'))).toBe(false);
  expect(commands.some(command => command.title === 'review')).toBe(false);
  await act(async () => getStorage().setState({ settingsScope: { serverId, accountId: 'another-owner' } }));
  expect(screen.findAll(node => node.props?.testID === 'session-skills:open:skills')[0]?.props.disabled).toBe(true);
  await act(async () => getStorage().setState({ settingsScope: { serverId, accountId: 'owner' } }));
  expect(screen.findAll(node => node.props?.testID === 'session-skills:open:skills')[0]?.props.disabled).toBe(false);
  expect(screen.findByType(SessionCapabilitiesContent)?.props.skillDetails('review').onPress).toBeTypeOf('function');
});

it('mounts one Session owner for the chip and the apply line, and adds nothing until intent', async () => {
  const sessionId = 'c123456789012345678901234';
  const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1, homeServerIdentityId: 'srv_chip_capabilities',
    canonicalServerUrl: 'https://chip-capabilities.test', revision: 1,
    endpoints: [{ kind: 'https', url: 'https://chip-capabilities.test' }] } });
  if (!home.serverIdentityId) throw new Error('Expected a qualified fixture Home');
  const credentials = await TokenStorage.getCredentialsForServerUrl('https://chip-capabilities.test', { serverId });
  if (!credentials) throw new Error('Expected the fixture Home credentials');
  await restoreConnectionToActiveServer(credentials);
  const scope = { serverId: home.serverIdentityId, accountId: 'owner' };
  const machine = createMachineFixture({ id: 'machine', activeAt: Date.now() });
  getStorage().setState({ settingsScope: scope, profileScope: scope });
  getStorage().getState().applyMachines([machine], true, {
    sourceServerId: scope.serverId, sourceAccountId: scope.accountId,
  });
  // A published Agent may omit optional capability declarations. The open sheet must still
  // render its catalog and known costs, without inventing native-disable support.
  const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {
    claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
  } });
  transport.mockImplementation(async (input: unknown) => input && typeof input === 'object'
    && Reflect.get(input, 'method') === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
    ? { protocolVersion: 1, projection } : preview);
  const binding = await renderHook(() => useServerCredentialAccountScopeBinding(scope.serverId));
  await vi.waitFor(() => expect(binding.getCurrent().binding).not.toBeNull());
  await act(async () => {
    expect(await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine', serverId: scope.serverId,
      accountLifetime: binding.getCurrent().binding! })).toMatchObject({ kind: 'ready' });
  });
  const reach = await renderHook(() => useReachMachines());
  expect(reach.getCurrent().machines[0]?.agentDeclarationsById?.claude).toMatchObject({ id: 'claude' });
  expect(reach.getCurrent().machines[0]?.agentDeclarationsById?.claude?.capabilities).toBeUndefined();
  transport.mockClear();
  const nativeCatalog = SessionSkillCatalogListResponseV1Schema.parse({ skills: [
      { origin: 'vendor', name: 'native-review', backendId: 'claude', path: '/native/native-review' },
      { origin: 'happier', name: 'injected-review', backendId: 'claude', path: '/session/skills/review' },
    ] });
  const owner = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'MacBook', machineId: 'machine', flavor: 'claude',
    startedBy: 'daemon', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
    agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } } } });
  if (!owner.ok) throw new Error('Invalid session owner fixture');
  const metadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: { v: 1 }, ownerMetadata: owner.ownerMetadata });
  const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
    dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
  for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
  getStorage().setState({
    sessions: {
      [sessionId]: createSessionFixture({
        id: sessionId,
        serverId,
        active: true,
        metadataLayoutVersion: 1,
        metadata: { path: '', host: '' },
        ownerMetadataView: MetadataSchema.parse({ ...metadata, sessionSkillCatalogV1: nativeCatalog }),
      }),
    },
    sessionLocalStateScope: scope,
  });
  const stop = vi.fn(async () => true);
  const resume = vi.fn(async () => true);
  const hook = await renderHook(() =>
    useExistingSessionCapabilitiesChip({
      target: React.useMemo(
        () => ({
          kind: 'session' as const,
          sessionId,
          serverId,
          readOnly: false,
        }),
        [],
      ),
      machineName: 'MacBook',
      machineOnline: true,
      turnSettled: false,
      stop,
      resume,
    }),
  );
  expect(hook.getCurrent().chip.controlId).toBe('capabilities');
  expect(hook.getCurrent().applyBadge).toBeNull();
  expect(transport).not.toHaveBeenCalled();
  // Closed and never hovered, the sheet stays idle; the intent is the one demand signal.
  expect(hook.getCurrent().model.state).toBe('resolving');
  const publishOwner = async (value: unknown) => act(async () => {
    getStorage().setState(current => ({ sessions: { ...current.sessions, [sessionId]: {
      ...current.sessions[sessionId]!, ownerMetadataView: MetadataSchema.parse({ ...MetadataSchema.parse(value), sessionSkillCatalogV1: nativeCatalog }),
    } } }));
  });
  const rulePending = writeCapabilitySelectionApplyV1(metadata, { skills: { source: 'rules', reason: 'next_turn' } });
  await publishOwner(rulePending);
  expect(hook.getCurrent().model.applyNotice).toMatchObject({ key: 'pendingNextTurn', text: 'Changes apply at the next turn' });
  expect(hook.getCurrent().applyBadge).toMatchObject({ label: 'Changes apply at the next turn', testID: 'session-capabilities-apply' });
  expect(transport).not.toHaveBeenCalled();
  await publishOwner(clearCapabilitySelectionApplyV1(rulePending, 'skills'));
  expect(hook.getCurrent().applyBadge).toBeNull();
  await act(async () => {
    hook.getCurrent().chip.onIntent?.();
  });
  await vi.waitFor(() => expect(hook.getCurrent().model.state).toBe('ready'));
  expect(hook.getCurrent().model.chipLabel).toBe(
    hook.getCurrent().chip.collapsedContentPopover?.label,
  );
  expect(stop).not.toHaveBeenCalled();

  // Mount the production detail leaf, rather than projecting a model in the test.
  const content = hook.getCurrent().chip.collapsedContentPopover!.renderContent;
  if (typeof content !== 'function') throw new Error('Expected the production sheet binding');
  const sheet = await renderScreen(<>{content({ maxHeight: 500, requestClose: () => {} })}</>);
  const before = transport.mock.calls.length;
  const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'linear', name: 'linear', transport: 'stdio',
    stdio: { command: 'linear', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
    toolsSnapshot: { checkedAt: 1, machineId: 'machine', tools: [{ name: 'search', tokens: 1400 }] } }],
    bindings: [{ id: 'linear-on', serverId: 'linear', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
  await act(async () => applyMcpServerCatalogSnapshot(scope, { status: 'ready', revision: 1, catalog, authority: 'active', diagnostics: [] }, true));
  await vi.waitFor(() => expect(transport.mock.calls.length).toBeGreaterThan(before));
  expect(sheet.findByType(SessionCapabilitiesContent)?.props.model).toMatchObject({ costKnown: true,
    groups: expect.arrayContaining([expect.objectContaining({ kind: 'mcp', rows: expect.arrayContaining([
      expect.objectContaining({ id: 'linear', line2: { kind: 'cost', cost: { toolCount: 1, tokensPerTurn: 1400 } } }),
    ]) })]) });
  // Closing the sheet drops its detail owners. A reopened sheet shows the cost facts the Session's sheet last knew
  // while the Account rows they come from are read again, and holds the rows it had.
  await sheet.unmount();
  resetMcpServerCatalogSnapshotsForTests();
  const reopened = await renderScreen(<>{content({ maxHeight: 500, requestClose: () => {} })}</>);
  const reopenedLinear = reopened.findByType(SessionCapabilitiesContent)?.props.model.groups[1].rows
    .find((row: { id: string }) => row.id === 'linear');
  expect(reopenedLinear).toMatchObject({ line2: { kind: 'cost', cost: { toolCount: 1, tokensPerTurn: 1400 } } });
  // The re-read lands: the same facts, now from the rows themselves.
  await act(async () => applyMcpServerCatalogSnapshot(scope, { status: 'ready', revision: 2, catalog, authority: 'active', diagnostics: [] }, true));
  expect(reopened.findByType(SessionCapabilitiesContent)?.props.model.groups[0].nativeRow.rows.map((row: { id: string }) => row.id)).toEqual(['native-review']);
  const notice = normalizeRawMessage('capability-failure', null, 2, { role: 'agent', content: { type: 'event', id: 'capability-failure', data: {
    type: 'message', message: 'Optional server failed', capabilityNoticeV1: { v: 1,
      items: [{ kind: 'mcp_server', itemId: 'linear', name: 'linear', code: 'spawn_failed' }] },
  } } });
  if (!notice) throw new Error('Expected a normalized capability notice');
  await act(async () => { getStorage().getState().applyMessages(sessionId, [notice]); });
  const failedRow = reopened.findByType(SessionCapabilitiesContent)?.props.model.groups[1].rows.find((row: { id: string }) => row.id === 'linear');
  expect(failedRow).toMatchObject({ line2: { kind: 'status', status: { kind: 'error' } } });
  expect(failedRow.line2.status.detail).toBeUndefined();
  const callsAfterFacts = transport.mock.calls.length;
  await act(async () => { hook.getCurrent().chip.onIntent?.(); });
  expect(transport.mock.calls).toHaveLength(callsAfterFacts);
});
