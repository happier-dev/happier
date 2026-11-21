import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolPrivateViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1, teamSharedResourceSummaryRowKeyV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { randomBytes } from 'node:crypto';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as collectionActionIds } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
  PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as collectionPaths,
  PluginCollectionSharingListResponseV1Schema,
  PluginCollectionSharingResourceV1Schema,
} from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability/v1';

import {
  collectRenderedTestIds,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import {
  createAccountTokenForTests,
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => vi.fn<() => Record<string, string>>(() => ({})));
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSettingsViewCommonModuleMocks({
  storage: 'real',
  router: async () => ({
    useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
    useNavigation: () => ({ setOptions: vi.fn() }),
    useLocalSearchParams: routeParams,
  }),
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
const { resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } =
  await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } =
  await import('@/sync/ops/teams/teamActionClient');
const { TeamSharedKindScreen } = await import('./TeamSharedKindScreen');
const { TeamSharedKindRoute } = await import('@/app/(app)/settings/teams/[serverId]/[teamId]/shared');
const { TeamSection } = await import('../TeamSection');
const { TeamSharedResourcesSection } = await import('../TeamSharedResourcesSection');
const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { createPluginSurfaceDestinationNavigationBinding, PluginSurfaceDestinationNavigationBindingProvider } =
  await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
const { t } = await import('@/text');

const POOLS = machinePoolActionEndpointPathV1('machines.pools.list');
const POOL_ID = '00000000-0000-4000-8000-000000000002';
const HOME_URL = 'https://shared-kind.example';
const ACCOUNT_ID = 'account-ada';
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

function sharedPool(name: string): MachinePoolPrivateViewV1 {
  return {
    sharedWithTeamScope: 'group',
    pool: {
      id: POOL_ID,
      description: null,
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
      members: [],
      audience: { kind: 'team', teamId: 'team-1' },
      name: {
        kind: 'available',
        label: { content: { t: 'plain', v: name }, recipientEnvelope: null },
      },
    },
    availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
  };
}

async function addHome(
  pools: readonly MachinePoolPrivateViewV1[],
): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home A',
    serverUrl: HOME_URL,
    accountId: ACCOUNT_ID,
    currentAccount: true,
    teamsEnabled: true,
    machinePoolsEnabled: true,
  });
  await harness.selectHomes([serverId]);
  harness.answer(serverId, '/v1/teams/get', {
    body: teamSummaryFixture({
      capabilities: teamCapabilitiesFixture({ viewRoster: true }),
    }),
  });
  harness.answer(serverId, POOLS, { body: { pools } });
  return serverId;
}

const ids = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  collectRenderedTestIds(screen.tree.toJSON());

beforeEach(async () => {
  resetTeamsSnapshotsForTests();
  resetTeamsDirectoryEngineForTests();
  resetTeamActionClientForTests();
  await harness.reset();
  await harness.selectHomes([]);
  routerPush.mockReset();
  routeParams.mockReset();
});
afterEach(async () => {
  standardCleanup();
  await accountConnection?.dispose();
  accountConnection = undefined;
});

describe('Team shared kind list', () => {
  it('opens the exact Collection when two plugins share the same Collection id', async () => {
    const serverId = await addHome([]);
    const kind = TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1;
    const collection = { pluginId: 'example.checklists', collectionId: 'notes' };
    const selected = { kind, status: 'available' as const, count: 1, collection };
    const other = { ...selected, collection: { ...collection, pluginId: 'example.other' } };
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: 'team-1' });
    harness.answer(serverId, summary.path, { body: { teamId: 'team-1', kinds: [selected, other] } });
    const screen = await renderScreen(<TeamSection serverId={serverId} teamId="team-1" title="Shared">
      {context => <TeamSharedResourcesSection context={context} />}
    </TeamSection>);
    const row = `team-overview-shared:${teamSharedResourceSummaryRowKeyV1(selected)}`;
    await vi.waitFor(() => expect(ids(screen)).toContain(row));
    await screen.pressByTestIdAsync(row);
    const destination = new URL(String(routerPush.mock.lastCall?.[0]), HOME_URL);
    expect(destination.searchParams.get('kind')).toBe(kind);
    expect(destination.searchParams.get('collectionPluginId')).toBe(collection.pluginId);
    expect(destination.searchParams.get('collectionId')).toBe(collection.collectionId);
  });

  it('lists the kind through its own Team-filtered list Action and opens each record at its owner', async () => {
    const serverId = await addHome([sharedPool('Build farm')]);
    const screen = await renderScreen(
      <TeamSharedKindScreen
        serverId={serverId}
        teamId="team-1"
        kind="machinePools"
      />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain(`team-shared-kind-row:${POOL_ID}`),
    );
    expect(harness.requestsFor(POOLS).map((request) => request.input)).toEqual([
      { sharedWithTeamId: 'team-1' },
    ]);
    screen.pressByTestId(`team-shared-kind-row:${POOL_ID}`);
    expect(routerPush).toHaveBeenLastCalledWith(
      expect.stringContaining(`/pools/${POOL_ID}?serverId=`),
    );
    await act(async () => screen.tree.unmount());

    harness.answer(serverId, POOLS, {
      body: { pools: [] },
      respondAfter: new Promise<void>(() => {}),
    });
    const returned = await renderScreen(
      <TeamSharedKindScreen serverId={serverId} teamId="team-1" kind="machinePools" />,
    );
    await vi.waitFor(() => expect(harness.requestsFor(POOLS)).toHaveLength(2));
    expect(ids(returned)).toContain(`team-shared-kind-row:${POOL_ID}`);
    expect(ids(returned)).not.toContain('team-shared-kind-loading');
  });

  it('heads the pushed kind page with its count, as the overview pane does, and offers no share flow it lacks', async () => {
    const serverId = await addHome([sharedPool('Build farm')]);
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: 'team-1' });
    harness.answer(serverId, summary.path, { body: { teamId: 'team-1', kinds: [{ kind: 'machinePools', status: 'available', count: 1 }] } });
    const screen = await renderScreen(<TeamSharedKindScreen serverId={serverId} teamId="team-1" kind="machinePools" />);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('teams.overview.summary.credentialsShared', { count: 1 })));
    // Machine pools share from each pool's own Share menu (lab L12-machinesp draws "Share a …" only where a flow exists).
    expect(ids(screen)).not.toContain('team-shared-kind-share');
  });

  it('says once when nothing of the kind is shared', async () => {
    const serverId = await addHome([]);
    const screen = await renderScreen(
      <TeamSharedKindScreen
        serverId={serverId}
        teamId="team-1"
        kind="machinePools"
      />,
    );
    await vi.waitFor(() =>
      expect(ids(screen)).toContain('team-shared-kind-empty'),
    );
    expect(
      ids(screen).filter((id) => id.startsWith('team-shared-kind-row:')),
    ).toEqual([]);
  });
});

describe('Team shared Collection rows', () => {
  const pluginId = 'example.checklists';
  const reader = 'checklist-reader';
  const version = '1.0.0';
  const archiveDigestSha256 = `sha256:${'a'.repeat(64)}`;
  const declaration = {
    id: 'checklists', schemaVersion: 1, rowIdField: 'id', identityFields: [],
    schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id', 'note'], additionalProperties: false },
    serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], migrations: [],
  } as const;
  const contract = normalizePluginAccountCollectionContractV1({ pluginId, contribution: declaration });
  const ref = { pluginId, collectionId: contract.collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
  const sharedRow = (id: string) => {
    const encoded = encodePluginCollectionLogicalValueV1({ contract, value: { id, note: 'Release steps' },
      isValidLogicalValue: (value): value is { id: string; note: string } => typeof value.id === 'string',
      encryptionMode: 'plain', material: null, randomBytes });
    if (encoded.status !== 'encoded') throw new Error(encoded.reason);
    return PluginCollectionSharingResourceV1Schema.parse({ pluginId, collectionId: ref.collectionId,
      ownerAccountId: 'account-mara', rowId: id, access: 'view', encryptionMode: 'plain', encryptedDataKey: null,
      sharedWithTeamScope: 'group', row: { rowId: id, revision: 1, content: encoded.content, projection: encoded.projection } });
  };

  /** The Home serves the Team, its admitted Collection and one Group-shared row; availability is the Account projection. */
  async function collectionHome(sharedRowDestination: string | undefined) {
    await addHome([]);
    accountConnection = await restoreServerAccountForTest({ serverUrl: HOME_URL, accountId: ACCOUNT_ID,
      credentials: { token: createAccountTokenForTests(ACCOUNT_ID, { currentAccount: true }) }, request: harness.request });
    installHomeGovernanceBoundaries(harness);
    const { serverId } = accountConnection;
    await harness.setActionPolicy(serverId, collectionActionIds.list, 'ui', 'allowed');
    harness.answer(serverId, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { body: { access: 'readOnly', contract } });
    harness.answer(serverId, collectionPaths.sharedWithMe, { body: PluginCollectionSharingListResponseV1Schema.parse({
      resources: [sharedRow('release-checklist')], nextCursor: null }) });
    const scope = createServerAccountScope(serverId, ACCOUNT_ID)!;
    const manifest = { schemaVersion: 2, id: pluginId, version, displayName: 'Checklists',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
      contributes: { accountCollections: [{ ...declaration, ...(sharedRowDestination ? { sharedRowDestination } : {}) }] } };
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, materializations: [], snapshots: [],
      intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 1, packageAssets: [], uiArtifacts: [],
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: { pluginId, desiredVersion: version, enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
        release: { ref: { pluginId, version }, archiveDigestSha256, normalizedManifest: manifest,
          collectionContracts: [ref], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] } },
      }) }] } });
    return { serverId, scope };
  }

  /** The App's navigation binding stays real; the page owner it hands the row to is the platform boundary. */
  function appNavigation(scope: NonNullable<ReturnType<typeof createServerAccountScope>>, outcome: { ok: true } | { ok: false; code: 'unavailable'; reason: string }) {
    const occurrenceId = 'installed-checklists';
    const opened: unknown[] = [];
    const navigation = createPluginSurfaceDestinationNavigationBinding({ targetKind: 'app',
      accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
      placements: [{ ...createPluginPagePlacementFixture({ pluginId, localId: reader, title: 'Checklist', targetKind: 'app' }),
        occurrenceId, hostAccountOrigin: { ...scope, custodyId: occurrenceId,
          sourceCustody: { kind: 'account_release', pluginId, version, archiveDigestSha256 } } }] });
    navigation.registerOwner({ container: 'appPage', handler: resolution => { opened.push(resolution.request); return outcome; } });
    return { navigation, opened };
  }

  const ROW = `team-shared-kind-row:${JSON.stringify(['account-mara', 'release-checklist'])}`;
  function renderCollection(serverId: string, navigation: ReturnType<typeof appNavigation>['navigation']) {
    routeParams.mockReturnValue({ serverId, teamId: 'team-1', kind: TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1,
      collectionPluginId: pluginId, collectionId: ref.collectionId });
    return renderScreen(<PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>
      <TeamSharedKindRoute />
    </PluginSurfaceDestinationNavigationBindingProvider>);
  }

  it('opens a Group-shared row at the plugin\'s declared reader with its qualified address', async () => {
    const { serverId, scope } = await collectionHome(reader);
    const { navigation, opened } = appNavigation(scope, { ok: true });
    const screen = await renderCollection(serverId, navigation);
    await waitForHomeGovernance(() => expect(ids(screen)).toContain(ROW));
    expect(harness.requestsFor(collectionPaths.sharedWithMe)).toEqual([expect.objectContaining({
      serverId, input: expect.objectContaining({ pluginId, collectionId: ref.collectionId, sharedWithTeamId: 'team-1' }),
    })]);
    expect(screen.getTextContent()).toContain('release-checklist');
    expect(screen.getTextContent()).toContain(t('teams.overview.shared.throughGroup'));
    expect(screen.getTextContent()).not.toContain(t('common.unavailable'));
    await screen.pressByTestIdAsync(ROW);
    await vi.waitFor(() => expect(opened).toEqual([{ destination: { pluginId, localId: reader },
      input: { pluginId, collectionId: ref.collectionId, ownerAccountId: 'account-mara', rowId: 'release-checklist' } }]));
    expect(screen.getTextContent()).not.toContain(t('common.unavailable'));
  });

  it('says Unavailable in the row when the reader refuses the row', async () => {
    const { serverId, scope } = await collectionHome(reader);
    const { navigation, opened } = appNavigation(scope, { ok: false, code: 'unavailable', reason: 'plugin_surface_unavailable' });
    const screen = await renderCollection(serverId, navigation);
    await waitForHomeGovernance(() => expect(ids(screen)).toContain(ROW));
    await screen.pressByTestIdAsync(ROW);
    expect(opened).toHaveLength(1);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('common.unavailable')));
    expect(() => screen.pressByTestId(ROW)).toThrow(/does not expose onPress\/onClick/);
  });

  it('keeps the row readable but Unavailable when the plugin declares no reader', async () => {
    const { serverId, scope } = await collectionHome(undefined);
    const { navigation } = appNavigation(scope, { ok: true });
    const screen = await renderCollection(serverId, navigation);
    await waitForHomeGovernance(() => expect(ids(screen)).toContain(ROW));
    expect(screen.getTextContent()).toContain('release-checklist');
    expect(screen.getTextContent()).toContain(t('teams.overview.shared.throughGroup'));
    expect(screen.getTextContent()).toContain(t('common.unavailable'));
    expect(() => screen.pressByTestId(ROW)).toThrow(/does not expose onPress\/onClick/);
  });
});
