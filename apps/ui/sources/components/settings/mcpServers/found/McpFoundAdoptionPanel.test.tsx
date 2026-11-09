import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DetectedMcpServerV1Schema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { McpServerCatalogV1Schema, McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { useMcpFoundAdoption } = await import('./useMcpFoundAdoption');
const { McpFoundAdoptionPanel } = await import('./McpFoundAdoptionPanel');
const { FieldTextInput } = await import('@/components/ui/forms/FieldTextInput');
const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
const { resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');

const found = DetectedMcpServerV1Schema.parse({
  provider: 'claude', name: 'github', transport: 'http', remote: { url: 'https://found.example.test/mcp', headers: ['Authorization'] },
  envKeys: ['REGION'], enabled: true, source: { kind: 'user', path: '/home/dev/.claude.json' },
});
let catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
let revision = 1;
let writes = 0;
let refuseWrite = false;
let disposeActionLoader: (() => void) | undefined;

beforeEach(async () => {
  await homes.reset();
  resetMcpServerCatalogEngineForTests();
  resetMcpServerCatalogSnapshotsForTests();
  const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
  resetScopedHomeActionExecutorsForTests();
  disposeActionLoader = await installRealActionExecutorModuleLoader();
  catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] });
  revision = 1; writes = 0; refuseWrite = false;
  const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { 'mcp.found.adopt': ['ui'] } });
  const serverId = await homes.addHome({ name: 'Found MCP', serverUrl: 'https://mcp-found-adoption.test',
    serverIdentityId: 'srv_mcp_found_adoption', accountId: 'owner', currentAccount: true });
  const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
  getStorage().setState(state => ({ settingsScope: scope, profileScope: scope, isDataReady: true,
    settings: { ...state.settings, actionsSettingsV1 } }));
  homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 0 } });
  homes.answer(serverId, 'GET /v1/account/entity-rows/mcp', { select: () => ({ body: {
    status: 'present', revision, content: { t: 'plain', v: catalog },
  } }) });
  // Only HTTP persistence is replaced: mounted admission, import materialization and CAS are real.
  homes.answer(serverId, 'POST /v1/account/entity-rows/mcp', { select: input => {
    const mutation = McpServerCatalogRowMutationV1Schema.parse(input);
    if (refuseWrite || mutation.expectedRevision !== revision) return { body: { status: 'conflict', revision } };
    if (!mutation.content || mutation.content.t !== 'plain') throw new Error('Plain fixture received no plain content');
    catalog = McpServerCatalogV1Schema.parse(mutation.content.v);
    writes += 1;
    return { body: { status: 'updated', revision: ++revision, cursor: revision } };
  } });
});
afterEach(async () => { await standardCleanup(); disposeActionLoader?.(); disposeActionLoader = undefined; });

async function mount() {
  let latest: ReturnType<typeof useMcpFoundAdoption> | null = null;
  let ready = false;
  function Harness({ online }: Readonly<{ online: boolean }>) {
    const scope = getStorage().getState().settingsScope!;
    const execution = useMountedActionExecution(scope);
    ready = execution.ready;
    const adoption = useMcpFoundAdoption({ machineId: 'machine-1', machineOnline: online, scopeKey: JSON.stringify(scope),
      catalog, catalogRevision: revision, execution });
    latest = adoption;
    return <McpFoundAdoptionPanel testID="adopt" adoption={adoption} secrets={[]} scope={scope} />;
  }
  const screen = await renderScreen(<Harness online />);
  await waitForHomeGovernance(() => expect(ready).toBe(true));
  return { screen, adoption: () => latest!, online: (online: boolean) => screen.update(<Harness online={online} />) };
}

async function fillValues(current: Awaited<ReturnType<typeof mount>>) {
  const field = (id: string) => current.screen.findAllByType(FieldTextInput).find(node => node.props.testID === id)!;
  await act(async () => { field('adopt.server.github.env.row.0.value').props.onChangeText('eu'); });
  await act(async () => { field('adopt.server.github.env.row.0.value').props.onBlur(); });
  const headerType = current.screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === 'adopt.server.github.header.row.0.type')!;
  await act(async () => { headerType.props.onSelect('literal'); });
  await act(async () => { field('adopt.server.github.header.row.0.value').props.onChangeText('${GITHUB_TOKEN}'); });
  await act(async () => { field('adopt.server.github.header.row.0.value').props.onBlur(); });
}

describe('McpFoundAdoptionPanel', () => {
  it('asks every named value, then admits the exact discovered target without changing its source configuration', async () => {
    const current = await mount();
    const source = JSON.stringify(found);
    await act(async () => { await current.adoption().begin(found); });
    expect(current.adoption().openValues).toBe(2);
    await current.screen.pressByTestIdAsync('adopt.add');
    expect(writes).toBe(0);
    expect(current.adoption().state.status).toBe('choosing');
    await fillValues(current);
    await current.screen.pressByTestIdAsync('adopt.add');
    await waitForHomeGovernance(() => expect(current.adoption().state.status).toBe('adopted'));
    expect(writes).toBe(1);
    expect(catalog.servers[0]).toMatchObject({ origin: { kind: 'machine', machineId: 'machine-1', agentId: 'claude' },
      env: { REGION: { t: 'literal', v: 'eu' } }, remote: { headers: { Authorization: { t: 'literal', v: '${GITHUB_TOKEN}' } } } });
    expect(JSON.stringify(found)).toBe(source);
    // A repeated request recovers the acknowledged entry instead of repeating its catalog effect.
    await act(async () => { await current.adoption().begin(found); });
    expect(current.adoption().state).toEqual({ status: 'adopted', serverId: catalog.servers[0]!.id });
    expect(writes).toBe(1);
  });

  it('keeps choices after an admitted conflict, retries only the missing catalog effect, and Cancel withdraws them', async () => {
    const current = await mount();
    await act(async () => { await current.adoption().begin(found); });
    await fillValues(current);
    refuseWrite = true;
    await current.screen.pressByTestIdAsync('adopt.add');
    await waitForHomeGovernance(() => expect(current.adoption().state).toMatchObject({ status: 'failed', errorCode: 'mcp_catalog_conflict' }));
    expect(current.adoption().answers.rows['github:env:REGION']).toEqual({ t: 'literal', v: 'eu' });
    expect(writes).toBe(0);
    refuseWrite = false;
    await current.screen.pressByTestIdAsync('adopt.add');
    await waitForHomeGovernance(() => expect(current.adoption().state.status).toBe('adopted'));
    expect(writes).toBe(1);
    await act(async () => { current.adoption().cancel(); });
    expect(current.adoption().model).toBeNull();
    expect(current.screen.findByTestId('adopt.add')).toBeNull();
  });

  it('refuses offline adoption, preserves an open values draft, and resumes it when the Machine returns', async () => {
    const current = await mount();
    await current.online(false);
    await act(async () => { await current.adoption().begin(found); });
    expect(current.adoption().state.status).toBe('idle');
    await current.online(true);
    await act(async () => { await current.adoption().begin(found); });
    await fillValues(current);
    await current.online(false);
    expect(current.screen.findByTestId('adopt.add')?.props.disabled).toBe(true);
    await act(async () => { await current.adoption().submit(); });
    expect(writes).toBe(0);
    expect(current.adoption().answers.rows['github:env:REGION']).toEqual({ t: 'literal', v: 'eu' });
    await current.online(true);
    await current.screen.pressByTestIdAsync('adopt.add');
    await waitForHomeGovernance(() => expect(current.adoption().state.status).toBe('adopted'));
    expect(writes).toBe(1);
  });
});
