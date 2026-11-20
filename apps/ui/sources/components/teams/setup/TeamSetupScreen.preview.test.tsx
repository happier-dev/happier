import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { ProjectSourceListItemV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import {
  renderScreen,
  standardCleanup,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

const router = vi.hoisted(() => ({ back: null as null | ((...args: unknown[]) => unknown) }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('expo-router', async () => {
  const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
  router.back = mock.spies.back;
  return mock.module;
});
// Only Home HTTP is scripted; the Team, Source and summary owners run as in production.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
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

it('previews the member page from the same Team reads, with nothing to run and a way back', async () => {
  onTestFinished(await installRealActionExecutorModuleLoader());
  const serverId = await homes.addHome({
    name: 'Preview Home',
    serverUrl: 'https://setup-preview.example.test',
    serverIdentityId: 'srv_setup_preview',
    accountId: 'admin',
    currentAccount: true,
    teamsEnabled: true,
  });
  storage.getState().activateProfileScope({
    serverId: resolveServerProfileScopeIdForIdentifier(serverId),
    accountId: 'admin',
  });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const team = teamSummaryFixture({ id: 'preview-team', name: 'Acme', policy: teamPolicyFixture({ managedDefaults: null }) });
  homes.answer(serverId, '/v1/teams/get', { body: team });
  const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: team.id });
  homes.answer(serverId, summary.path, { body: { teamId: team.id, kinds: [] } });
  const web = ProjectSourceListItemV1Schema.parse({
    id: 'source-web', revision: 1, name: 'Storefront', createdByAccountId: 'admin',
    audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }],
    repository: {
      provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'acme/web' }, protocol: 'https',
    },
  });
  homes.answer(serverId, '/v1/projects/sources', {
    body: { ok: true, sources: [web], coverage: { complete: true, nextCursor: null } },
  });
  const screen = await renderScreen(<TeamSetupScreen serverId={serverId} teamId={team.id} preview />);
  try {
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('team-setup-repository:source-web'), screen.getTextContent()).not.toBeNull());
    const text = screen.getTextContent();
    expect(text).toContain(t('teams.join.setupPage.previewLead', { team: 'Acme' }));
    expect(text).toContain(t('teams.join.setupPage.previewMachine'));
    expect(screen.findByTestId('team-setup-run')).toBeNull();
    await screen.pressByTestIdAsync('team-setup-preview-close');
    expect(router.back).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
