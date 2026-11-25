import * as React from 'react';
import { act } from 'react-test-renderer';
import { ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolPrivateViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1, teamSharedResourceSummaryRowKeyV1, type TeamSharedResourceSummaryRowV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { randomBytes } from 'node:crypto';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as collectionActionIds } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import {
  PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as collectionPaths,
  PluginCollectionSharingListResponseV1Schema,
} from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MANAGED_MACHINE_PRESET_PAGE_SIZE_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
  collectRenderedTestIds,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
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
const { useTeamSharedResourcesSummary } = await import('@/hooks/teams/useTeamSharedResourcesSummary');
/** The overview owns the one summary read and hands it to the section. */
function SharedSection(props: Readonly<{ context: React.ComponentProps<typeof TeamSharedResourcesSection>['context'] }>) {
  const summary = useTeamSharedResourcesSummary({ scope: props.context.scope, address: props.context.address, enabled: true });
  return <TeamSharedResourcesSection context={props.context} summary={summary} />;
}
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
  options?: Partial<Parameters<typeof harness.addHome>[0]>,
): Promise<string> {
  const serverId = await harness.addHome({
    name: 'Home A',
    serverUrl: HOME_URL,
    accountId: ACCOUNT_ID,
    currentAccount: true,
    teamsEnabled: true,
    machinePoolsEnabled: true,
    ...options,
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
  it.each([
    { code: 'permission_denied', status: 403, message: 'teams.errors.forbidden' },
    { code: 'invalid_request', status: 400, message: 'homeGovernance.invalidRead' },
  ] as const)('explains a settled preset list refusal $code without Retry', async ({ code, status, message }) => {
    const serverId = await addHome([], { serverIdentityId: 'srv_shared_machine_presets' });
    harness.answer(serverId, '/v1/machines/presets/list', { status, body: { kind: 'refused', code } });

    const screen = await renderScreen(<TeamSharedKindScreen serverId={serverId} teamId="team-1" kind="machinePresets" />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t(message)));
    expect(ids(screen)).toContain('team-shared-kind-failed');
    expect(ids(screen)).not.toContain('team-shared-kind-failed-retry');
    expect(ids(screen)).not.toContain('team-shared-kind-more');
  });

  it.each([
    { title: 'loads only the visible preset page and repairs recipients only for the selected preset', failContinuation: false },
    { title: 'keeps visible presets and allows a manual retry after a failed scroll continuation', failContinuation: true },
  ])('$title', async ({ failContinuation }) => {
    const homeId = 'srv_shared_machine_presets';
    const teamId = 'team-1';
    const credentials = {
      token: createAccountTokenForTests(ACCOUNT_ID, { currentAccount: true }),
      secret: encodeBase64(new Uint8Array(32).fill(33), 'base64url'),
    };
    const encryption = await createEncryptionFromAuthCredentials(credentials);
    const serverId = await addHome([], { serverIdentityId: homeId, accountEncryptionMode: 'e2ee', credentials });
    const recipient = {
      account: { kind: 'account' as const, accountId: ACCOUNT_ID, name: null, firstName: 'Ada', lastName: null, username: null, avatarUrl: null },
      readiness: {
        status: 'available' as const,
        contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64'),
        contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
      },
      envelopeStatus: 'missing' as const,
    };
    const archivedAt = Date.UTC(2026, 10, 21, 12);
    const presets = ['preset-1', 'preset-2', 'preset-3'].map((id, index) => {
      const sealed = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee',
        content: { v: 1, name: `Private Team setup ${index + 1}`, setup: { scripts: [{ body: 'echo ready' }] } }, recipientCensus: [recipient], randomBytes });
      return {
        id, homeId, revision: 0, setupRevision: 0, owner: { kind: 'team', teamId }, contentEncryptionMode: 'e2ee',
        content: sealed.content, recipients: sealed.recipients, ...(index === 2 ? { archivedAt } : {}),
      };
    });
    let listBodies = 0;
    let detailBodies = 0;
    let failNextContinuation = failContinuation;
    harness.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    harness.answer(serverId, '/v1/machines/presets/list', { select: input => {
      const { cursor } = input as { cursor?: string };
      if (cursor !== undefined && failNextContinuation) {
        failNextContinuation = false;
        return { status: 503, body: { error: 'unavailable' } };
      }
      const page = cursor === undefined ? presets.slice(0, 2) : presets.slice(2);
      listBodies += page.length;
      return { body: { kind: 'listed', presets: page, ...(cursor === undefined ? { cursor: 'preset-2' } : {}) } };
    } });
    harness.answer(serverId, '/v1/machines/presets/get', { select: input => {
      const selected = presets.find(row => row.id === (input as { id?: string }).id);
      if (!selected) return { status: 404, body: { kind: 'refused', code: 'preset_not_found' } };
      detailBodies += 1;
      return { body: { kind: 'found', preset: selected } };
    } });
    harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: { kind: 'ready', contentEncryptionMode: 'e2ee',
      recipients: [{ ...recipient, envelopeStatus: 'prepared' }] } });
    harness.answer(serverId, '/v1/machines/managed/list', { body: { machines: [] } });

    const screen = await renderScreen(<TeamSharedKindScreen serverId={serverId} teamId={teamId} kind="machinePresets" />);
    await vi.waitFor(() => expect(ids(screen)).toContain('team-shared-kind-row:preset-2'));
    const readCounts = () => ({
      pageRequests: harness.requestsFor('/v1/machines/presets/list').length,
      listBodies,
      detailBodies,
      census: harness.requestsFor('/v1/machines/presets/recipient-census').length,
    });
    expect(readCounts()).toEqual({ pageRequests: 1, listBodies: 2, detailBodies: 0, census: 0 });
    expect(JSON.stringify(screen.tree.toJSON())).toContain('Private Team setup 1');
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Private Team setup 3');
    expect(ids(screen)).toContain('team-shared-kind-more');
    const scroller = screen.findByType(ScrollView);
    const scrollTo = async (y: number) => await act(async () => scroller.props.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y },
        layoutMeasurement: { width: 320, height: 400 },
        contentSize: { width: 320, height: 900 },
      },
    }));
    await scrollTo(200);
    expect(readCounts()).toEqual({ pageRequests: 1, listBodies: 2, detailBodies: 0, census: 0 });
    await scrollTo(500);
    if (failContinuation) {
      await waitForHomeGovernance(() => expect(readCounts()).toEqual({ pageRequests: 2, listBodies: 2, detailBodies: 0, census: 0 }));
      expect(ids(screen)).toContain('team-shared-kind-row:preset-2');
      await waitForHomeGovernance(() => expect(ids(screen)).toContain('team-shared-kind-failed'));
      expect(ids(screen)).not.toContain('team-shared-kind-more');
      await screen.pressByTestIdAsync('team-shared-kind-failed-retry');
    }
    const pageRequests = failContinuation ? 3 : 2;
    await waitForHomeGovernance(() => expect(ids(screen)).toContain('team-shared-kind-row:preset-3'));
    expect(readCounts()).toEqual({ pageRequests, listBodies: 3, detailBodies: 0, census: 0 });
    expect(JSON.stringify(screen.tree.toJSON())).toContain('Private Team setup 3');
    expect(ids(screen)).not.toContain('team-shared-kind-more');
    const query = { homeId, sharedWithTeamId: teamId, includeArchived: true, limit: MANAGED_MACHINE_PRESET_PAGE_SIZE_V1 };
    const nextQuery = { ...query, cursor: 'preset-2' };
    expect(harness.requestsFor('/v1/machines/presets/list').map(request => request.input)).toEqual(
      failContinuation ? [query, nextQuery, nextQuery] : [query, nextQuery],
    );

    await screen.pressByTestIdAsync('team-shared-kind-row:preset-3');
    expect(routerPush).toHaveBeenCalledWith(`/settings/machines/presets/preset-3?serverId=${encodeURIComponent(homeId)}`);
    const { useMachinePresetDetail } = await import('@/components/settings/machines/managed/useMachinePresets');
    const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
    const detail = await renderHook(() => useMachinePresetDetail(homeId, 'preset-3'));
    await vi.waitFor(() => expect(detail.getCurrent().state.value?.preset).toMatchObject({ name: 'Private Team setup 3',
      setup: { scripts: [expect.objectContaining({ body: 'echo ready' })] }, archivedAt }));
    expect(readCounts()).toEqual({ pageRequests, listBodies: 3, detailBodies: 1, census: 1 });
    expect(harness.requestsFor('/v1/machines/presets/get').map(request => request.input)).toEqual([{ homeId, id: 'preset-3' }]);
  });

  it('opens the selected Saved Secret at its own Home after one Team-filtered metadata read', async () => {
    const serverId = await addHome([]);
    const ref = formatSharedSavedSecretRefV1(POOL_ID);
    const list = vi.fn((_input: unknown, request: { url: string }) => {
      expect(new URL(request.url).searchParams.get('sharedWithTeamId')).toBe('team-1');
      return {
        body: SharedSavedSecretListOutputV1Schema.parse({
          resources: [{ ref, source: 'shared_resource', relationship: 'recipient', name: 'Release key',
            kind: 'token', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } }],
          nextCursor: null,
        }),
      };
    });
    harness.answer(serverId, '/v1/account/saved-secrets/resources', { select: list });
    const screen = await renderScreen(<TeamSharedKindScreen serverId={serverId} teamId="team-1" kind="savedSecrets" />);
    const row = `team-shared-kind-row:${ref}`;
    await vi.waitFor(() => expect(ids(screen)).toContain(row));
    await screen.pressByTestIdAsync(row);
    const destination = new URL(String(routerPush.mock.lastCall?.[0]), HOME_URL);
    expect(destination.pathname.endsWith('/settings/connected-services/secrets')).toBe(true);
    expect(destination.searchParams.get('serverId')).toBe(serverId);
    expect(destination.searchParams.get('secret')).toBe(ref);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('opens the exact Collection when two plugins share the same Collection id', async () => {
    const serverId = await addHome([]);
    const kind = TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1;
    const collection = { pluginId: 'example.checklists', collectionId: 'notes' };
    const selected: TeamSharedResourceSummaryRowV1 = { kind, status: 'available', count: 1, collection };
    const other = { ...selected, collection: { ...collection, pluginId: 'example.other' } };
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: 'team-1' });
    harness.answer(serverId, summary.path, { body: { teamId: 'team-1', kinds: [selected, other] } });
    const screen = await renderScreen(<TeamSection serverId={serverId} teamId="team-1" title="Shared">
      {context => <SharedSection context={context} />}
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
  const declaration: Parameters<typeof normalizePluginAccountCollectionContractV1>[0]['contribution'] = {
    id: 'checklists', schemaVersion: 1, rowIdField: 'id', identityFields: [],
    schema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id', 'note'], additionalProperties: false },
    serverReadable: ['id'], indexes: [], uiQueries: [], relations: [], migrations: [],
  };
  const contract = normalizePluginAccountCollectionContractV1({ pluginId, contribution: declaration });
  const ref = { pluginId, collectionId: contract.collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
  const sharedRow = { ownerAccountId: 'account-mara', rowId: 'release-checklist', sharedWithTeamScope: 'group' };

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
      resources: [], identities: [sharedRow], nextCursor: null }) });
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
      serverId, input: expect.objectContaining({ pluginId, collectionId: ref.collectionId, sharedWithTeamId: 'team-1', projection: 'identity' }),
    })]);
    expect(harness.requestsFor(collectionPaths.get)).toHaveLength(0);
    expect(harness.requestsFor(collectionPaths.census)).toHaveLength(0);
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
