import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfilePolicyV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

import { createDeferred, standardCleanup } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

const routerPush = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
  router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: routerPush },
  }).module,
  storage: 'real',
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});

// Metro's deferred module loader and HTTP are genuine runtime boundaries; Action preparation,
// approval policy, mounted execution and settings-screen pending state remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();

let disposeExecutorLoader: (() => void) | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let PublicProfileSettingsScreen: typeof import('./PublicProfileSettingsScreen')['PublicProfileSettingsScreen'];

beforeAll(async () => {
  disposeExecutorLoader = await installRealActionExecutorModuleLoader();
  ({ PublicProfileSettingsScreen } = await import('./PublicProfileSettingsScreen'));
}, 120_000);

afterAll(() => disposeExecutorLoader?.());
afterEach(async () => {
  routerPush.mockReset();
  standardCleanup();
  await connection?.dispose();
  connection = null;
  await harness.reset();
});

describe('PublicProfileSettingsScreen approval defaults', () => {
  it('runs Resume and Sync now directly by default, then clears each busy state after the write', async () => {
    const resumeResponse = createDeferred<void>();
    const refreshResponse = createDeferred<void>();
    const startMs = Date.parse('2026-10-20T00:00:00Z');
    const endMs = startMs + 86_400_000;
    const query = normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs, endMs },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
      includeQuotaHistory: false, includeActivity: true });
    const policy = PublicProfilePolicyV1Schema.parse({ ...DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      fields: Object.fromEntries(Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields).map(field => [field, field === 'tokens'])) });
    const snapshot = { v: 1 as const, computedAtMs: startMs, period: { startMs, endMs, timeZoneOffsetMinutes: 0 },
      coverage: { status: 'partial' as const, method: 'runtime' as const },
      fieldCoverage: { tokens: { status: 'partial' as const, method: 'runtime' as const } }, facts: { tokens: 10 } };
    let state: 'paused' | 'published' = 'paused';
    const record = () => ({ state, policy, metadata: {}, projectSelections: [], query, snapshot,
      layout: { v: 1 as const, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      updatedAtMs: startMs, publishedAtMs: startMs, restriction: null });
    const owner = () => PublicProfileOwnerReadV1Schema.parse({ kind: 'ready',
      context: { handle: 'ada', identity: {}, service: { displayName: 'Profile Home', publicBaseUrl: 'https://profile-settings.test' },
        urls: { page: 'https://profile-settings.test/@ada', json: 'https://profile-settings.test/@ada/json',
          badgeBase: 'https://profile-settings.test/@ada/badge', card: 'https://profile-settings.test/@ada/card.svg',
          og: 'https://profile-settings.test/@ada/og.png', report: 'mailto:operator@profile-settings.test' } }, record: record() });
    const tokens = { input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
      totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
      contributions: [{ id: 'usage-1', observedAtMs: endMs, sessionId: null, turnId: null, agentId: 'codex',
        modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
        sourceContext: { path: 'runtime', execution: 'happier' }, eventCount: 1, tokens,
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }],
      activity: { calendarDays: [{ date: '2026-10-20', eventCount: 1 }] },
      coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
        range: { startMs, endMs, complete: false }, sources: [{ source: 'runtime', path: 'runtime', status: 'available',
          eventCount: 1, asOfMs: endMs, historyComplete: false }] },
    });
    const serverId = await harness.addHome({ name: 'Profile settings', serverUrl: 'https://profile-settings.test',
      accountId: 'account-a', currentAccount: true });
    const profile = AccountProfileSchema.parse({ id: 'account-a', username: 'ada' });
    harness.answer(serverId, '/v1/account/profile', { body: profile });
    for (const path of ['/v2/sessions/active', '/v2/sessions', '/v2/session-organization']) {
      harness.answer(serverId, `GET ${path}`, { select: async () => {
        const response = createEmptyAccountBootstrapHttpResponse(path);
        if (!response) throw new Error(`Missing Account bootstrap fixture: ${path}`);
        return { status: response.status, body: await response.json() };
      } });
    }
    harness.answer(serverId, '/v1/machines?includeRevoked=true', { body: [] });
    const home = harness.findByServerUrl('https://profile-settings.test');
    if (!home?.token) throw new Error('Expected the Profile Home credential');
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: 'account-a',
      credentials: { token: home.token }, request: harness.request });
    // Both Actions declare direct UI confirmation. Explicit Ask overrides are
    // covered at the shared approval-policy owner (actionApprovalPolicy.test.ts).
    harness.answer(serverId, 'GET /v1/account/public-profile', { select: () => ({ body: owner() }) });
    harness.answer(serverId, 'POST /v2/usage/query', { body: accounting });
    harness.answer(serverId, 'POST /v1/account/public-profile/resume', { select: () => {
      state = 'published';
      return { respondAfter: resumeResponse.promise, body: { kind: 'updated', record: record() } };
    } });
    harness.answer(serverId, 'PUT /v1/account/public-profile/snapshot', {
      respondAfter: refreshResponse.promise,
      body: { kind: 'updated', record: record() },
    });
    const features = createRootLayoutFeaturesResponse({
      features: { account: { publicProfiles: { enabled: true } } },
    });
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    const screen = await renderScreen(<PublicProfileSettingsScreen />);
    try {
      await vi.waitFor(() => expect(screen.findByTestId('settings-public-profile-resume')).toBeTruthy());
      expect(screen.findByTestId('settings-public-profile-resume')?.props.disabled).toBe(false);
      await act(async () => {
        screen.pressByTestId('settings-public-profile-resume');
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(harness.requests.filter(request => request.path === '/v1/account/public-profile/resume')).toHaveLength(1));
      expect(routerPush).not.toHaveBeenCalled();
      expect(screen.findByTestId('settings-public-profile-resume')?.props.disabled).toBe(true);
      await act(async () => resumeResponse.resolve());
      await vi.waitFor(() => expect(screen.findByTestId('settings-public-profile-pause')).toBeTruthy());
      expect(screen.findByTestId('settings-public-profile-resume')).toBeNull();

      const sync = screen.findByTestId('settings-public-profile-sync');
      expect(sync).toBeTruthy();
      expect(sync?.props.disabled).toBe(false);
      await act(async () => {
        screen.pressByTestId('settings-public-profile-sync');
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(harness.requests.filter(request => request.path === '/v1/account/public-profile/snapshot')).toHaveLength(1));
      expect(routerPush).not.toHaveBeenCalled();
      expect(screen.findByTestId('settings-public-profile-sync')?.props.disabled).toBe(true);
      await act(async () => refreshResponse.resolve());
      await vi.waitFor(() => expect(screen.findByTestId('settings-public-profile-sync')?.props.disabled).toBe(false));
      expect(routerPush).not.toHaveBeenCalled();
    } finally {
      resumeResponse.resolve();
      refreshResponse.resolve();
      await screen.unmount();
    }
  });
});
