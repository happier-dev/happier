import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1,
  TeamCredentialResourceCatalogEntryV1Schema,
  TeamCredentialResourceDiscoveryPageV1Schema,
} from '@happier-dev/protocol/teams/credentials/resourceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import {
  renderScreen,
  standardCleanup,
  teamCredentialDisplayNameFixture,
  teamCredentialResourceFixture,
  teamCredentialViewerFixture,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
// Only Home HTTP is scripted; the Team, Source, summary and credential catalog owners run as in production.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Load the page and its owners once at collection, outside the test's time budget, as the sibling setup tests do.
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { t } = await import('@/text');
const { TeamSetupScreen } = await import('./TeamSetupScreen');
beforeEach(async () => {
  await homes.reset();
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

it('lists the keys a Team shares on its setup page instead of calling the Team empty', async () => {
  onTestFinished(await installRealActionExecutorModuleLoader());
  const serverId = await homes.addHome({
    name: 'Setup Home',
    serverUrl: 'https://setup-keys.example.test',
    serverIdentityId: 'srv_setup_keys',
    accountId: 'member',
    currentAccount: true,
    teamsEnabled: true,
    credentialResourcesEnabled: true,
  });
  storage
    .getState()
    .activateProfileScope({
      serverId: resolveServerProfileScopeIdForIdentifier(serverId),
      accountId: 'member',
    });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const team = teamSummaryFixture({
    id: 'keys-team',
    name: 'Acme',
    policy: teamPolicyFixture({ managedDefaults: null }),
  });
  homes.answer(serverId, '/v1/teams/get', { body: team });
  const summary = bindHomeDomainActionHttpRequestV1(
    TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1,
    { v: 1, teamId: team.id },
  );
  homes.answer(serverId, summary.path, {
    body: {
      teamId: team.id,
      kinds: [{ kind: 'credentials', status: 'available', count: 1 }],
    },
  });
  homes.answer(serverId, '/v1/projects/sources', {
    body: {
      ok: true,
      sources: [],
      coverage: { complete: true, nextCursor: null },
    },
  });
  homes.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
    // The recipient catalog: what this member may use, read through discovery.
    body: TeamCredentialResourceDiscoveryPageV1Schema.parse({
      resources: [TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'key-1', teamId: team.id, displayName: teamCredentialDisplayNameFixture('Acme OpenAI key'),
        resourceRevision: 1, sourcePresentation: teamCredentialResourceFixture().sourcePresentation,
        readiness: teamCredentialResourceFixture().readiness, recoveryAction: null, allowedRoutes: ['brokered'],
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
      })],
      nextCursor: null,
      failures: [],
    }),
  });
  homes.answer(serverId, '/v1/teams/credential-resources/list', {
    body: {
      resources: [
        teamCredentialResourceFixture({
          id: 'key-1',
          teamId: team.id,
          displayName: teamCredentialDisplayNameFixture('Acme OpenAI key'),
        }),
      ],
      viewer: teamCredentialViewerFixture({}),
    },
  });
  const screen = await renderScreen(
    <TeamSetupScreen serverId={serverId} teamId={team.id} />,
  );
  try {
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('team-setup-keys'),
        screen.getTextContent(),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('Acme OpenAI key');
    expect(screen.getTextContent()).toContain(
      t('teams.join.setupPage.keyShared'),
    );
    expect(screen.findByTestId('team-setup-empty')).toBeNull();
  } finally {
    await screen.unmount();
  }
});
