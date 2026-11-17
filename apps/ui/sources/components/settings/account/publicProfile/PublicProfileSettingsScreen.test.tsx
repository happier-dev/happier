import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real',
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
// Adapt Metro's deferred import boundary; mounted execution and feature decisions stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
// Collection owns the full executor graph; lifecycle hooks only manage test consumers.
const disposeLoader = await installRealActionExecutorModuleLoader();
const { PublicProfileSettingsScreen } = await import('./PublicProfileSettingsScreen');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterAll(() => disposeLoader());
afterEach(async () => {
  standardCleanup();
  await connection?.dispose();
  connection = null;
  await harness.reset();
});

const context = { handle: 'leeroy', identity: {}, service: null, urls: null };
const restriction = { removedAtMs: 1_700_000_000_000, reason: 'Impersonation report' };
const unpublishedRecord = {
  state: 'draft', policy: null, metadata: null, projectSelections: [], query: null, snapshot: null,
  layout: null, appearance: null, updatedAtMs: 1_700_000_000_000, publishedAtMs: null, restriction,
};

async function renderOwnerPage(restricted: boolean) {
  const serverUrl = 'https://profile-restriction.test';
  const serverId = await harness.addHome({ name: 'Profile restriction', serverUrl,
    accountId: 'account-a', currentAccount: true });
  harness.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'account-a', username: 'leeroy' }) });
  for (const path of ['/v2/sessions/active', '/v2/sessions', '/v2/session-organization']) {
    harness.answer(serverId, `GET ${path}`, { select: async () => {
      const response = createEmptyAccountBootstrapHttpResponse(path);
      if (!response) throw new Error(`Missing Account bootstrap fixture: ${path}`);
      return { status: response.status, body: await response.json() };
    } });
  }
  harness.answer(serverId, '/v1/machines?includeRevoked=true', { body: [] });
  const home = harness.findByServerUrl(serverUrl);
  if (!home?.token) throw new Error('Expected the Profile Home credential');
  connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a',
    credentials: { token: home.token }, request: harness.request });
  const ownerRead = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context,
    record: { ...unpublishedRecord, restriction: restricted ? restriction : null } });
  harness.answer(serverId, 'GET /v1/account/public-profile', { body: ownerRead });
  const features = createRootLayoutFeaturesResponse({ features: { account: { publicProfiles: { enabled: true } } } });
  harness.answer(serverId, '/v1/features', { body: features });
  harness.answer(serverId, '/v1/features/authenticated', { body: features });
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  const screen = await renderScreen(<PublicProfileSettingsScreen />);
  await vi.waitFor(() => expect(screen.findByTestId('settings-public-profile-loading')).toBeNull());
  return screen;
}

describe('PublicProfileSettingsScreen', () => {
  it('tells the owner why their page was removed even after they unpublished it', async () => {
    const screen = await renderOwnerPage(true);

    expect(screen.getTextContent()).toContain(t('publicIdentity.profile.restrictedTitle'));
    expect(screen.findByTestId('settings-public-profile-restricted')).toBeTruthy();
    expect(screen.getTextContent()).toContain('Impersonation report');
    expect(screen.getTextContent()).toContain(t('publicIdentity.profile.restrictedTitle'));
  });

  it('shows no removal notice for an unrestricted draft', async () => {
    const screen = await renderOwnerPage(false);

    expect(screen.findByTestId('settings-public-profile-restricted')).toBeNull();
  });
});
