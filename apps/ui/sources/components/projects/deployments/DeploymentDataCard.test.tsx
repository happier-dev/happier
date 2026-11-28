import * as React from 'react';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentDataCard } = await import('./DeploymentDataCard');
const { DeploymentEnvironmentDetail } = await import('./DeploymentEnvironmentDetail');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { Item } = await import('@/components/ui/lists/Item');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
afterEach(async () => { standardCleanup(); await homes.reset(); });

/** The read projection the card receives: an opened detail without a linked runtime or retained receipts. */
function readDetail(overrides: Parameters<typeof createDeploymentEnvironmentDetailV1>[0]) {
  return { ...createDeploymentEnvironmentDetailV1(overrides), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
}

it('presents the provider-produced database engine after association and keeps legacy links recognizable', async () => {
  const serverId = await homes.addHome({ name: 'Database console', serverUrl: 'https://database-console.test', accountId: 'owner', currentAccount: true });
  const scope = { serverId, accountId: 'owner' };
  const provider = { data: { engine: 'postgres', version: '17',
    providerConsole: { url: 'https://console.example.test/project', label: 'Open console' } } };
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', role: 'data', targetKind: 'example-database', machines: [], members: [], source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
  const detail = readDetail({ targetLinks: [{ targetLink, content: provider }] });
  const screen = await renderScreen(<DeploymentDataCard scope={scope} detail={detail} onAdd={() => {}} onBackups={() => {}} />);
  try {
    expect(screen.findAllByType(Item).some(row => row.props.title === 'PostgreSQL 17')).toBe(true);
    const providerConsole = screen.findByTestId('project-deployments.environment.data.providerConsole.database');
    expect(providerConsole).not.toBeNull();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    try {
      await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'off');
      await act(async () => { await providerConsole!.props.onPress(); });
      expect(open).not.toHaveBeenCalled();
      await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'allowed');
      await act(async () => { await providerConsole!.props.onPress(); });
      expect(open.mock.calls.map(call => call[0])).toEqual(['https://console.example.test/project']);
    } finally { vi.unstubAllGlobals(); }
    await act(async () => screen.update(<DeploymentDataCard scope={scope} detail={readDetail({ targetLinks: [{ targetLink,
      content: { ...provider, data: { engine: 'postgres', version: '17' } } }] })} onAdd={() => {}} onBackups={() => {}} />));
    expect(screen.findAllByType(Item).some(row => row.props.title === 'PostgreSQL 17')).toBe(true);
    expect(screen.findByTestId('project-deployments.environment.data.providerConsole.database')).toBeNull();
    await act(async () => screen.update(<DeploymentDataCard scope={scope} detail={readDetail({ targetLinks: [{ targetLink, content: { ...provider, data: undefined } }] })}
      onAdd={() => {}} onBackups={() => {}} />));
    expect(screen.findAllByType(Item).some(row => row.props.title === 'example-database')).toBe(true);
  } finally { await screen.unmount(); }
});

it('opens header-only data links through the Artifact owner only while the card is presented', async () => {
  const serverId = await homes.addHome({ name: 'Linked database', serverUrl: 'https://linked-database.test', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', role: 'data', targetKind: 'example-database', machines: [], members: [],
    source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
  await account.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
    header: { kind: 'deployment-target-link.v1', title: 'Customer database' },
    body: JSON.stringify({ data: { engine: 'postgres', version: '17',
      providerConsole: { url: 'https://console.example.test/project', label: 'Open console' } } }) });
  const detail = readDetail({ targetLinks: [{ targetLink }] });
  const readCount = () => homes.requestsFor('/v1/artifacts/read').length;
  const initialReads = readCount();
  const card = (presented: boolean) => <DeploymentDataCard scope={account.accountLifetime.scope} lifetime={account.accountLifetime}
    presented={presented} detail={detail} onAdd={() => {}} onBackups={() => {}} />;
  const screen = await renderScreen(card(false));
  try {
    expect(readCount()).toBe(initialReads);
    await act(async () => screen.update(card(true)));
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findAllByType(Item).some(row => row.props.title === 'PostgreSQL 17')).toBe(true); });
    expect(screen.findByTestId('project-deployments.environment.data.providerConsole.database')).not.toBeNull();
    expect(readCount()).toBe(initialReads + 1);
    await act(async () => screen.update(card(true)));
    expect(readCount()).toBe(initialReads + 1);
  } finally { await screen.unmount(); account.dispose(); }
});

it('keeps a header-only database navigable while its body is pending and exposes read failure with recovery', async () => {
  const serverId = await homes.addHome({ name: 'Unavailable database', serverUrl: 'https://unavailable-database.test', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const pending = createDeferred<void>();
  let unavailable = true;
  homes.answer(serverId, '/v1/artifacts/read', { select: async (_input, request) => {
    if (unavailable) {
      await pending.promise;
      return { status: 503, body: { error: 'artifact_content_unavailable' } };
    }
    const response = await homes.artifacts(serverId).handle('/v1/artifacts/read', request.init);
    if (!response) throw new Error('Expected Artifact boundary response');
    return { status: response.status, body: await response.json() };
  } });
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'database', role: 'data', targetKind: 'example-database', machines: [], members: [],
    source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
  await account.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
    header: { kind: 'deployment-target-link.v1', title: 'Customer database' },
    body: JSON.stringify({ data: { engine: 'postgres', version: '17' } }) });
  const open = vi.fn();
  const screen = await renderScreen(<DeploymentDataCard scope={account.accountLifetime.scope} lifetime={account.accountLifetime} presented
    detail={readDetail({ targetLinks: [{ targetLink }] })} onOpen={open} onAdd={() => {}} onBackups={() => {}} />);
  try {
    expect(screen.findByTestId('project-deployments.environment.data.loading')).not.toBeNull();
    await screen.pressByTestIdAsync('project-deployments.environment.data.database.database');
    expect(open).toHaveBeenCalledWith(targetLink.id);
    pending.resolve();
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findByTestId('project-deployments.environment.data.failed')).not.toBeNull(); });
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const failure = screen.findAllByType(SurfaceStateCard).find(row => row.props.testID === 'project-deployments.environment.data.failed');
    expect(failure?.props.action).toBeDefined();
    unavailable = false;
    await act(async () => failure?.props.action?.onPress());
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findAllByType(Item).some(row => row.props.title === 'PostgreSQL 17')).toBe(true); });
    expect(screen.findByTestId('project-deployments.environment.data.failed')).toBeNull();
  } finally { pending.resolve(); await screen.unmount(); account.dispose(); }
});

it('keeps the native Database address unless a known roster excludes it', async () => {
  const detail = readDetail({ content: nativeDatabaseContent() });
  const onOpen = vi.fn();
  const page = (deployedServices?: readonly string[]) => <DeploymentDataCard scope={{ serverId: 'home', accountId: 'owner' }}
    detail={detail} place="Database Machine" onAdd={() => {}} onBackups={() => {}} onOpen={onOpen} deployedServices={deployedServices} />;
  const screen = await renderScreen(page(['web']));
  const database = 'project-deployments.environment.data.database.postgres';
  try {
    expect(screen.findByTestId(database)).toBeNull();
    // Unknown is independent of a known absence.
    await act(async () => screen.update(page()));
    expect(screen.findByTestId(database)).not.toBeNull();
    await act(async () => screen.update(page(['web', 'postgres'])));
    await screen.pressByTestIdAsync(database);
    expect(onOpen).toHaveBeenCalledWith('postgres');
  } finally { await screen.unmount(); }
});

function nativeDatabaseContent() {
  const { content } = createDeploymentEnvironmentDetailV1();
  return { ...content, template: {
    templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '17', ref: { kind: 'version' as const, version: '17' } },
    definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
    services: ['postgres'], data: [{ engine: 'postgres' as const, service: 'postgres' }],
  } };
}

it('opens an existing native Database from Overview with a retained attempt and no serving deployment', async () => {
  const serverIdentityId = `srv_${'a'.repeat(32)}`;
  const serverId = await homes.addHome({ name: 'Existing native Database', serverUrl: 'https://native-database.test',
    serverIdentityId, accountId: 'account-owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const { accountLifetime } = account;
  const environment = createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId });
  const targetLink = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: undefined });
  const prior = createDeploymentReceiptDetailV1({
    deployment: createDeploymentReceiptHeaderV1({ environmentId: environment.id, targetLinkId: targetLink.id }),
  });
  const path = `/v1/deployments/environments/${environment.id}`;
  await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
    header: { kind: 'deployment-environment.v1', title: 'Staging' }, body: JSON.stringify(nativeDatabaseContent()) });
  await account.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
    header: { kind: 'deployment-target-link.v1', title: 'Native runtime' }, body: '{}' });
  await account.createArtifactDocument({ artifactId: prior.deployment.contentArtifactId,
    header: { kind: 'deployment-receipt.v1', title: 'Previous deployment' }, body: JSON.stringify(prior.content) });
  homes.answer(serverId, `GET ${path}`, { body: { ok: true, environment, targetLinks: [targetLink] } });
  homes.answer(serverId, `GET ${path}/deployments`, { body: { ok: true, items: [prior.deployment], nextCursor: null } });
  homes.answer(serverId, `GET ${path}/domains`, { body: { ok: true, environmentId: environment.id,
    revision: environment.revision, domains: [], nextCursor: null } });
  const scope = { ...accountLifetime.scope, projectSourceId: environment.projectSourceId };
  const controller = createDeploymentReadControllerV1({ scope, transport: createDeploymentReadTransport(accountLifetime) });
  const demand = { mounted: true, visible: true, focused: true };
  const history = controller.acquireHistory(environment.id, { attemptsOnly: true }, demand);
  const onOpenDatabase = vi.fn();
  const screen = await renderAccountScreen(<DeploymentEnvironmentDetail controller={controller} environmentId={environment.id}
    demand={demand} lifetime={accountLifetime} accountId={scope.accountId} serverId={serverId}
    phone={false} deploy={null} destination={{ tab: 'overview', section: null }}
    review={{ pendingId: null, request() {}, open() {} }} onOpenReceipt={() => {}} onOpenDatabase={onOpenDatabase} />);
  const database = 'project-deployments.environment.data.database.postgres';
  try {
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(history.getSnapshot()).toMatchObject({ status: 'ready', value: { items: [{ id: prior.deployment.id }] } });
      expect(screen.findByTestId(database)).not.toBeNull();
    });
    await screen.pressByTestIdAsync(database);
    expect(onOpenDatabase).toHaveBeenCalledWith('postgres');
  } finally {
    await screen.unmount();
    history.release();
    controller.retire();
    account.dispose();
  }
});
