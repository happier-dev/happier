import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema, PublicProfileOwnerRecordV1Schema, PublicProfilePublishBodyV1Schema,
  type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { buildWidgetSurfaceArtifactIdV1 } from '@happier-dev/protocol/widgets';
import { UsageCrew, UsagePeriodSummaryBody } from '@happier-dev/plugin-ui/presentation';

import { standardCleanup } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { applyUsageSocketUpdate } from '@/sync/engine/socket/usageUpdates';
import { publishHomeAccountChangeWake } from '@/sync/runtime/orchestration/homeAccountChange';

installSettingsViewCommonModuleMocks({ storage: 'real',
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  modal: async () => vi.importActual<typeof import('@/modal')>('@/modal'),
});
// Metro's deferred import and HTTP are runtime boundaries; the mounted Action flow stays real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
// Radix's DOM interaction adapter is outside this native renderer; modal custody stays real.
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
  return createRadixCjsModuleMock();
});
// SCM RPC is the Machine transport boundary; repository admission and Action readiness stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', { spy: true });
const scmTransport = vi.hoisted(() => vi.fn());
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
// The full production executor is a collection dependency. Do not import its entire graph inside
// a test lifecycle hook; the bridge still exposes the real module and disposes with this suite.
const disposeLoader = await installRealActionExecutorModuleLoader();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const machineRpcBoundary = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const { PublicProfileEditorScreen } = await import('./PublicProfileEditorScreen');
const { PublicProfileWidgetArea } = await import('./PublicProfileWidgetArea');
const { PublicProfileEditor } = await import('./PublicProfileEditor');
const { PublicProfileReview } = await import('./PublicProfileReview');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { t } = await import('@/text');
afterAll(() => disposeLoader());
afterEach(async () => {
  standardCleanup();
  await connection?.dispose();
  connection = null;
  await harness.reset();
  vi.restoreAllMocks();
  scmTransport.mockReset();
});

async function openEditor(published: boolean, usage?: Readonly<{ eventCount: number;
  work?: Readonly<{ branch: Promise<unknown>; pullRequests: Promise<unknown> }> }>, lifecycle = false,
  publicationBeforeResponse = true) {
  const startMs = Date.parse('2026-10-20T00:00:00Z');
  const endMs = startMs + 86_400_000;
  const query = normalizeUsageQuery({ population: 'public_eligible_personal', period: { relative: '90days' },
    includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
    includeQuotaHistory: false, includeActivity: true, includeComparison: false });
  let record: PublicProfileOwnerRecordV1 | null = published ? {
    state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], query,
    snapshot: { v: 1, computedAtMs: startMs, period: { startMs, endMs, timeZoneOffsetMinutes: 0 },
      coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {}, facts: { activeDays: 1 } },
    layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    updatedAtMs: startMs, publishedAtMs: startMs, restriction: null,
  } : null;
  const context = { handle: 'ada', identity: {},
    service: { displayName: 'Profile Home', publicBaseUrl: 'https://profile-editor.test' },
    urls: { page: 'https://profile-editor.test/@ada', json: 'https://profile-editor.test/@ada/json',
      badgeBase: 'https://profile-editor.test/@ada/badge', card: 'https://profile-editor.test/@ada/card.svg',
      og: 'https://profile-editor.test/@ada/og.png', report: 'mailto:operator@profile-editor.test' } };
  const serverId = await harness.addHome({ name: 'Profile editor', serverUrl: 'https://profile-editor.test',
    accountId: 'account-a', currentAccount: true });
  harness.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: 'account-a', username: 'ada' }) });
  for (const path of ['/v2/sessions/active', '/v2/sessions', '/v2/session-organization']) {
    harness.answer(serverId, `GET ${path}`, { select: async () => {
      const response = createEmptyAccountBootstrapHttpResponse(path);
      if (!response) throw new Error(`Missing bootstrap fixture: ${path}`);
      return { status: response.status, body: await response.json() };
    } });
  }
  harness.answer(serverId, '/v1/machines?includeRevoked=true', { body: [] });
  const home = harness.findByServerUrl('https://profile-editor.test');
  if (!home?.token) throw new Error('Expected Profile Home credential');
  connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: 'account-a',
    credentials: { token: home.token }, request: harness.request });
  await harness.setActionPolicy(serverId, 'widgets.item.remove', 'ui', 'allowed');
  if (lifecycle) await harness.setActionPolicy(serverId, 'account.public_profile.unpublish', 'ui', 'allowed');
  const { storage } = await import('@/sync/domains/state/storageStore');
  storage.setState({ settingsScope: { serverId, accountId: 'account-a' } });
  harness.answer(serverId, 'GET /v1/account/public-profile', { select: () => ({ body: PublicProfileOwnerReadV1Schema.parse(
    record ? { kind: 'ready', context, record } : { kind: 'absent', context }) }) });
  const eventCount = usage?.eventCount ?? 1;
  const fixtureAtMs = usage ? startMs + 100 : endMs;
  const rowTokens = { input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
  const tokens = { ...rowTokens, input: eventCount * 8, output: eventCount * 2, total: eventCount * 10 };
  const accounting = repriceUsageAnalyticsResponse(UsageAnalyticsQueryResponseSchema.parse({ v: 1,
    totals: { eventCount, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
    contributions: Array.from({ length: eventCount }, (_, index) => ({ id: `usage-${index + 1}`, observedAtMs: fixtureAtMs,
      sessionId: usage ? 'profile-work' : null, turnId: usage ? 'profile-turn' : null, agentId: 'codex',
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
      sourceContext: { path: 'runtime', execution: 'happier' }, eventCount: 1, tokens: rowTokens,
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } })),
    activity: { calendarDays: [{ date: '2026-10-20', eventCount }] },
    coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
      range: { startMs, endMs, complete: false }, sources: [{ source: 'runtime', path: 'runtime', status: 'available',
        eventCount, asOfMs: endMs, historyComplete: false }] } }));
  harness.answer(serverId, 'POST /v2/usage/query', { body: accounting });
  const deliveries: UsageAnalyticsQueryBatchResponse[] = [];
  const batchRequests: unknown[] = [];
  // The feature peer advertises its real contract. Delivery must follow the
  // actual negotiated request, never a fixture-forced compact projection.
  harness.answer(serverId, 'POST /v2/usage/query-batch', { select: input => {
    batchRequests.push(input);
    const request = UsageAnalyticsQueryBatchRequestSchema.parse(input);
    const delivered = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
      results: request.queries.map(query => {
        const range = query.dateRange ?? { startMs, endMs };
        const includesFixture = (range.startMs === undefined || fixtureAtMs >= range.startMs)
          && (range.endMs === undefined || fixtureAtMs < range.endMs);
        // A real HTTP peer answers the requested window, including the empty
        // comparison. Its range and compact population must identify one period.
        const value = repriceUsageAnalyticsResponse({ ...accounting,
          ...(includesFixture ? {} : { totals: { eventCount: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [], activity: { calendarDays: [] } }),
          coverage: { ...accounting.coverage!, range: { ...range, complete: false },
            sources: accounting.coverage!.sources.map(source => ({ ...source, eventCount: includesFixture ? eventCount : 0 })) },
        });
        return { query, value };
      }),
    }, request, false));
    deliveries.push(delivered);
    return { body: delivered };
  } });
  if (usage) {
    const session = createPlainSessionWithDisplayRecordFixture({
      id: 'profile-work', createdAt: startMs, updatedAt: endMs, seq: 1, active: false, activeAt: endMs,
      metadataVersion: 1, agentStateVersion: 1, metadata: { path: '/profile-work', host: 'profile-host' },
    });
    const turns = { v: 1, sessionId: 'profile-work', updatedAt: endMs,
      turns: [{ turnId: 'profile-turn', agentId: 'codex', status: 'completed', startedAt: startMs + 100, terminalAt: startMs + 600, updatedAt: startMs + 600 }] };
    harness.answer(serverId, 'GET /v2/sessions/profile-work', { body: { session } });
    harness.answer(serverId, 'GET /v1/sessions/profile-work/turns', { body: turns });
    // Usage now admits projected private facts through its own HTTP boundary.
    // Keep the witnessed Session/turn source; exercise the real Resource parser and admission.
    harness.answer(serverId, `POST ${USAGE_SESSION_EVIDENCE_PATH}`, { select: input => {
      const request = UsageSessionEvidenceRequestSchema.parse(input);
      const requests = request.requests.map(demand => ({ query: demand.query, sessionIds: demand.sessionIds ?? [session.id] }));
      return { body: UsageSessionEvidenceResponseSchema.parse({ requests,
        results: [...new Set(requests.flatMap(demand => demand.sessionIds))].map(sessionId => ({ sessionId,
          detail: { status: 200, body: { session } }, turns: { status: 200, body: turns } })) }) };
    } });
  }
  if (usage?.work) {
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applySessions([createSessionFixture({ id: 'profile-work', active: false, serverId, createdAt: startMs, updatedAt: endMs, activeAt: endMs,
      metadataLayoutVersion: 1, metadata: { path: '/profile-work', host: 'profile-host' },
      ownerMetadataView: { machineId: 'profile-machine', path: '/profile-work', host: 'profile-host' } })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'profile-machine' })]);
    scmTransport.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.SCM_BRANCH_LIST
      ? usage.work!.branch : usage.work!.pullRequests);
    vi.spyOn(machineRpcBoundary, 'machineRpcWithServerScope').mockImplementation(scmTransport);
  }
  const writes: unknown[] = [];
  const write = { select: (input: unknown) => {
    writes.push(input);
    if (lifecycle) {
      const body = PublicProfilePublishBodyV1Schema.parse(input);
      record = PublicProfileOwnerRecordV1Schema.parse({ ...body,
        state: 'published', updatedAtMs: Date.now(), publishedAtMs: Date.now(), restriction: null });
      if (publicationBeforeResponse) publishHomeAccountChangeWake(serverId,
        { t: 'account-change', changeKinds: ['account'], entityIds: ['public-profile'], sessionSystemRecords: [] }, 'socket');
    }
    return { body: { kind: 'updated', record } };
  } };
  harness.answer(serverId, 'POST /v1/account/public-profile/publish', write);
  harness.answer(serverId, 'PUT /v1/account/public-profile/policy', write);
  harness.answer(serverId, 'DELETE /v1/account/public-profile', { select: () => {
    record = null;
    return { body: { kind: 'updated', record: null } };
  } });
  const features = createRootLayoutFeaturesResponse({ features: { account: { publicProfiles: { enabled: true } } } });
  for (const path of ['/v1/features', '/v1/features/authenticated']) harness.answer(serverId, path, { body: features });
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
  let actionExecution: ReturnType<typeof useMountedActionExecution> | null = null;
  function ActionSession() {
    actionExecution = useMountedActionExecution({ serverId, accountId: 'account-a' });
    return null;
  }
  const contentNode = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
  const screen = await renderScreen(<AuthProvider initialCredentials={{ token: home.token }}>
    <ModalProvider>{lifecycle ? <ActionSession /> : null}<PublicProfileEditorScreen /></ModalProvider>
  </AuthProvider>, usage ? {
    createNodeMock: element => {
      // DOM geometry is the boundary; the real scroll/near-viewport owner
      // decides whether these placed profile blocks are currently visible.
      if (element.type === 'ScrollView') return { getInnerViewNode: () => contentNode };
      if (['totals', 'days', 'crew', 'planet'].some(id => element.props.testID === `public-profile-area.widget.${id}`))
        return { getBoundingClientRect: () => ({ left: 0, top: 100, width: 600, height: 220 }) };
      return null;
    },
  } : {});
  await vi.waitFor(() => expect(screen.findByTestId('public-profile-editor-submit')?.props.disabled).toBe(false));
  return { screen, writes, serverId, deliveries, batchRequests,
    unpublish: async () => {
      if (!actionExecution) throw new Error('Expected mounted Action Session');
      const outcome = await actionExecution.execute('account.public_profile.unpublish', {});
      expect(outcome).toMatchObject({ ok: true, result: { kind: 'updated', record: null } });
      publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'],
        entityIds: ['public-profile'], sessionSystemRecords: [] }, 'socket');
    } };
}

it.each(['before response', 'after response'])('confirm Publish reads once when its publication push arrives %s', async delivery => {
  const { screen, writes, serverId } = await openEditor(false, undefined, true, delivery === 'before response');
  const reads = () => harness.requests.filter(request => request.path === '/v1/account/public-profile' && request.method === 'GET').length;
  const editor = () => screen.findAll(node => node.type === PublicProfileEditor)[0];
  try {
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull());
    const before = reads();
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    await vi.waitFor(() => expect(editor().props.submitting).toBe(false));
    // The confirmed record settles the owner immediately, even before its push is delivered.
    expect(editor().props.status).toBe('published');
    if (delivery === 'after response') await act(async () => {
      publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'],
        entityIds: ['public-profile'], sessionSystemRecords: [] }, 'socket');
    });
    await vi.waitFor(() => expect(editor().props.status).toBe('published'));
    expect(screen.findByTestId('public-profile-editor-copy-link')).not.toBeNull();
    expect(reads() - before).toBe(1);
  } finally { await screen.unmount(); }
});

it('publishes the same chosen Look through review and Action after another Session unpublishes', async () => {
  const { screen, writes, unpublish } = await openEditor(false, undefined, true);
  const editor = () => screen.findAll(node => node.type === PublicProfileEditor)[0];
  const review = () => screen.findAll(node => node.type === PublicProfileReview)[0];
  try {
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull());
    const chosen = review().props.disclosure.appearance;
    expect(chosen.atmosphere).toMatchObject({ source: 'planet', planet: { placement: 'rise' } });
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    await vi.waitFor(() => expect(editor().props.status).toBe('published'));
    await act(async () => { await unpublish(); });
    await vi.waitFor(() => expect(editor().props.status).toBe('draft'));
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull());
    expect(review().props.disclosure.appearance).toEqual(chosen);
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    await vi.waitFor(() => expect(editor().props.status).toBe('published'));
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ appearance: chosen });
  } finally { await screen.unmount(); }
});

it('retires the publication result and moment on an acknowledged Unpublish push before another review', async () => {
  const { screen, unpublish } = await openEditor(false, undefined, true);
  const editor = () => screen.findAll(node => node.type === PublicProfileEditor)[0];
  try {
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull());
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    await vi.waitFor(() => expect(editor().props.status).toBe('published'));
    expect(screen.findByTestId('public-profile-editor-copy-link')).not.toBeNull();
    await act(async () => { await unpublish(); });
    await vi.waitFor(() => expect(editor().props.status).toBe('draft'));
    expect(editor().props.notice).toBeNull();
    expect(editor().props.noticeMoment).toBeNull();
    expect(screen.findByTestId('public-profile-editor-copy-link')).toBeNull();
    expect(screen.findByTestId('public-profile-editor-badge')).toBeNull();
  } finally { await screen.unmount(); }
});

it('keeps open owner pages quiet for Usage and settings changes, then reads once each for a publication change', async () => {
  const { screen, serverId } = await openEditor(true);
  const reads = () => harness.requests.filter(request => request.path === '/v1/account/public-profile' && request.method === 'GET').length;
  // Owner edition/context and the independent Action preview admission each read once.
  expect(reads()).toBe(2);
  const home = harness.findByServerUrl('https://profile-editor.test')!;
  const { PublicProfileSettingsScreen } = await import('./PublicProfileSettingsScreen');
  const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
  const settings = await renderScreen(<AuthProvider initialCredentials={{ token: home.token! }}>
    <ModalProvider><PublicProfileSettingsScreen /></ModalProvider>
  </AuthProvider>);
  try {
    await vi.waitFor(() => expect(settings.findByTestId('settings-public-profile-status')).not.toBeNull());
    const before = reads();
    expect(before).toBe(3);
    await act(async () => {
      for (let index = 0; index < 12; index++) {
        applyUsageSocketUpdate({ type: 'usage', id: null, key: 'native', tokens: { total: index + 1 },
          cost: { total: 0 }, timestamp: index + 1 }, serverId, 'account-a');
        applyUsageSocketUpdate({ type: 'usage-sources-invalidated', machineId: 'machine', installationId: 'installation' }, serverId, 'account-a');
        publishHomeAccountChangeWake(serverId, { t: 'account-settings-changed', settingsVersion: index + 1 }, 'socket');
        publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['session', 'artifact'],
          entityIds: ['native-session', 'approval-artifact'], sessionSystemRecords: [] }, 'socket');
      }
    });
    expect(reads() - before).toBe(0);
    harness.answer(serverId, 'GET /v1/account/public-profile', { body: PublicProfileOwnerReadV1Schema.parse({
      kind: 'absent', context: { handle: 'ada', identity: {}, service: null, urls: null },
    }) });
    await act(async () => {
      publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'],
        entityIds: ['public-profile'], sessionSystemRecords: [] }, 'socket');
    });
    await vi.waitFor(() => expect(settings.findByTestId('settings-public-profile-invitation')).not.toBeNull());
    expect(reads() - before).toBe(2);
  } finally { await settings.unmount(); await screen.unmount(); }
});

it('settles the shared preview after a requested Work branch proves unsupported without acquiring held PR evidence', async () => {
  const branch = createDeferred<unknown>();
  const pullRequests = createDeferred<unknown>();
  const { screen, deliveries } = await openEditor(false, { eventCount: 1,
    work: { branch: branch.promise, pullRequests: pullRequests.promise } });
  const view = () => screen.findAll(node => node.type === PublicProfileEditor)[0]?.props.ownerView;
  try {
    await vi.waitFor(() => expect(scmTransport).toHaveBeenCalledTimes(1));
    expect(view()).toBeNull();
    branch.resolve({ success: false, errorCode: 'NOT_REPOSITORY' });
    await vi.waitFor(() => expect(view()?.snapshot.facts).toMatchObject({ tokens: 10, activeDays: 1 }));
    expect(view()?.snapshot.fieldCoverage.mergedPrs.status).toBe('unavailable');
    expect(scmTransport.mock.calls.every(([request]) => request.method === RPC_METHODS.SCM_BRANCH_LIST)).toBe(true);
    expect(deliveries).toHaveLength(1);
  } finally {
    branch.resolve({ success: false, errorCode: 'NOT_REPOSITORY' });
    pullRequests.resolve({ success: false, errorCode: 'NOT_REPOSITORY' });
    await screen.unmount();
  }
});

it('prepares the real editor and Publish review from compact facts for 32975 events on one witnessed turn', async () => {
  const eventCount = 32_975;
  const { screen, writes, deliveries, batchRequests } = await openEditor(false, { eventCount });
  try {
    const view = () => screen.findAll(node => node.type === PublicProfileEditor)[0]?.props.ownerView;
    await vi.waitFor(() => expect(view()?.snapshot.facts).toMatchObject({ tokens: eventCount * 10, activeDays: 1,
      agentTimeMs: 500, peakParallel: 1, agentMix: [{ agentId: 'codex', share: 1 }] }));
    // Native layout is an OS boundary. The real widget/frame owners need its
    // event before measured bodies mount, as on the actual editor screen.
    await act(async () => {
      for (const node of screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function'))
        node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 400 } } });
    });
    await vi.waitFor(() => expect(screen.findAll(node => node.type === UsagePeriodSummaryBody)[0]?.props.hero)
      .toMatchObject({ id: 'tokens', value: formatTokenCount(eventCount * 10) }));
    await vi.waitFor(() => expect(screen.findAll(node => node.type === UsageCrew)[0]?.props.model).toMatchObject([{ agentId: 'codex', share: 1 }]));
    console.info('usage-profile-1031 cold compact editor delivery', { events: eventCount, distinctTurns: 1,
      responseBytes: deliveries.map(delivered => new TextEncoder().encode(JSON.stringify(delivered)).byteLength) });
    expect(batchRequests.length).toBeGreaterThan(0);
    for (const request of batchRequests) expect(request).toMatchObject({ includeContributions: false, contributionQueries: [] });
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(async () => {
      // Publish continues after its press handler returns; flush the native
      // renderer before observing the review mounted by that continuation.
      await act(async () => {});
      expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull();
    }, { timeout: 300_000 }); // The reported regression is no review within the observed five-minute window.
    expect(writes).toEqual([]);
    expect(deliveries).toHaveLength(1);
    expect(batchRequests).toHaveLength(1);
    for (const request of batchRequests) expect(request).toMatchObject({ includeContributions: false, contributionQueries: [] });
    let populatedPeriods = 0;
    for (const delivered of deliveries) {
      expect(delivered.results).toHaveLength(1);
      for (const result of delivered.results) if ('value' in result) {
        expect(result.value).not.toHaveProperty('contributions');
        const population = result.value.summary?.publicProfileAccounting;
        expect(population).toBeDefined();
        if (population?.total.contributionCount) {
          populatedPeriods++;
          expect(population).toMatchObject({ total: { contributionCount: eventCount },
            membership: { turns: [{ sessionId: 'profile-work', turnId: 'profile-turn', executions: ['happier'] }] } });
        } else expect(population?.membership.turns).toEqual([]);
      }
      expect(delivered.contributionPages?.flatMap(page => page.rows) ?? []).toEqual([]);
    }
    expect(populatedPeriods).toBeGreaterThan(0);
    console.info('usage-profile-1031 compact editor delivery', { events: eventCount, distinctTurns: 1,
      responseBytes: deliveries.map(delivered => new TextEncoder().encode(JSON.stringify(delivered)).byteLength),
      privateSessionReads: harness.requests.filter(request => request.path === '/v2/sessions/read-batch').length });
  } finally { await screen.unmount(); }
});

it('first Publish retains its exact prepared copy after the selected page source changes during review', async () => {
  let nowMs = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
  const { screen, writes, serverId } = await openEditor(false);
  try {
    const profileCosts = () => ({
      ownerReads: harness.requests.filter(request => request.path === '/v1/account/public-profile' && request.method === 'GET').length,
      usageReads: harness.requests.filter(request => request.path === '/v2/usage/query-batch' && request.method === 'POST').length,
    });
    await vi.waitFor(() => expect(profileCosts().usageReads).toBe(1));
    console.info('profile-preparation-cost', { phase: 'editor-ready', ...profileCosts() });
    await vi.waitFor(() => expect(screen.findAll(node => node.type === PublicProfileEditor)[0]?.props.ownerView?.snapshot).toBeDefined());
    // A later Home change advances shared Usage; Review keeps the preview this editor admitted.
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    nowMs += 310_000;
    await act(async () => { publishHomeAccountChange(serverId); });
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull());
    // Publish consumes the already-admitted accounting result used by preview.
    expect(profileCosts().usageReads).toBe(1);
    console.info('profile-preparation-cost', { phase: 'publish-review', ...profileCosts() });
    expect(writes).toEqual([]);
    expect(screen.getTextContent()).toContain(t('publicIdentity.review.daily'));
    // Another editor can change the private placement while this captured public copy is reviewed.
    const area = screen.findAll(node => node.type === PublicProfileWidgetArea)[0]?.props.widgetArea;
    if (!area) throw new Error('Expected mounted widget area');
    await act(async () => {
      expect(await area.binding.port.execute({ actionId: 'widgets.item.remove', instanceId: 'totals' })).toMatchObject({ ok: true });
      await area.area.reload();
    });
    await vi.waitFor(() => {
      const current = screen.findAll(node => node.type === PublicProfileWidgetArea)[0]?.props.widgetArea;
      expect(current?.candidate?.layout.items.some((item: { id: string }) => item.id === 'totals')).toBe(false);
    });
    await screen.pressByTestIdAsync('public-profile-review-confirm');
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ layout: { items: expect.arrayContaining([expect.objectContaining({ id: 'totals' })]) } });
  } finally { await screen.unmount(); }
});

it('Apply and its Undo execute through the prepared Action without another disclosure sheet', async () => {
  const { screen, writes } = await openEditor(true);
  try {
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(screen.findByTestId('public-profile-review')).toBeNull();
    // A transport admission precedes the acknowledged result that offers Undo.
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-editor-undo')).not.toBeNull());
    await screen.pressByTestIdAsync('public-profile-editor-undo');
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(screen.findByTestId('public-profile-review')).toBeNull();
    expect(writes[1]).toMatchObject({ layout: { v: 1, items: [] } });
  } finally { await screen.unmount(); }
});

it('retires an open Publish review when its captured Account changes, without dispatching it', async () => {
  const { screen, writes, serverId } = await openEditor(false);
  try {
    await screen.pressByTestIdAsync('public-profile-editor-submit');
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).not.toBeNull());
    await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
    await vi.waitFor(() => expect(screen.findByTestId('public-profile-review-confirm')).toBeNull());
    expect(writes).toEqual([]);
  } finally { await screen.unmount(); }
});

it('retains hydrated blocks with one degraded area notice after a read 503, then recovers on Retry', async () => {
  const { screen, serverId } = await openEditor(true);
  const area = () => screen.findAll(node => node.type === PublicProfileWidgetArea)[0]?.props.widgetArea;
  try {
    await vi.waitFor(() => expect(area()?.status).toBe('ready'));
    const admitted = area().area.state;
    const candidate = area().candidate;
    const path = `GET /v1/artifacts/${buildWidgetSurfaceArtifactIdV1(admitted.surface)}`;
    let refusedReads = 0;
    harness.answer(serverId, path, { select: () => { refusedReads++; return { status: 503, body: { error: 'unavailable' } }; } });
    await act(async () => { await area().area.reload(); });
    expect(refusedReads).toBeGreaterThan(0);
    expect(area().area.state).toMatchObject({ status: 'ready', readFailure: {
      reasonCode: 'widget_area_unavailable',
    } });
    expect(area().area.state.items).toBe(admitted.items);
    expect(area().candidate).toBe(candidate);
    expect(screen.findByTestId('public-profile-area.readFailed')).not.toBeNull();
    expect(screen.findByTestId('public-profile-area.unavailable')).toBeNull();
    expect(screen.findAll(node => node.type === PublicProfileEditor)[0]?.props.notice).toBeNull();
    harness.answer(serverId, path, { status: 404, body: { error: 'Artifact not found' } });
    await screen.pressByTestIdAsync('public-profile-area.retry');
    await vi.waitFor(() => expect(area()?.status).toBe('ready'));
    expect(area().area.state).not.toHaveProperty('readFailure');
    expect(area().area.state.items).toBe(admitted.items);
  } finally { await screen.unmount(); }
});
