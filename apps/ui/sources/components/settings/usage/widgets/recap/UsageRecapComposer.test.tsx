import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { projectUsageAnalyticsBatchDelivery, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { installBrowserClipboardBoundary, renderScreen, standardCleanup } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { UsageRecapComposer } from './UsageRecapComposer';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';

// The platform clipboard and the router are the effect boundaries; Action admission stays real.
const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>());
beforeEach(() => { installBrowserClipboardBoundary(clipboard); });
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); clipboard.mockReset(); routerPush.mockReset(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; vi.restoreAllMocks(); });
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD' } } };

async function mount(route: Parameters<typeof serveAccountHomes>[0]['route'], query = normalizeUsageQuery({ agents: ['claude', 'codex'] }), beforeRender?: () => void,
  options: Readonly<{ publicProfiles?: boolean; onClose?: () => void; initialOutput?: 'badge' }> = {}) {
  await import('@/sync/ops/actions/defaultActionExecutor');
  const features = createRootLayoutFeaturesResponse();
  if (options.publicProfiles) features.features.account = { ...features.features.account, publicProfiles: { enabled: true } };
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://recap-compose.test', accountId: 'a' }],
    route: request => request.path === '/v1/account/encryption/currentness'
      ? Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 })
      : request.path === '/v1/features' || request.path === '/v1/features/authenticated' ? Response.json(features)
      : route(request) });
  const server = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  await getServerFeaturesSnapshot({ serverId: server.id, force: true });
  let updateQuery!: (next: UsageQuery) => void;
  function Host() {
    const [shownQuery, setQuery] = React.useState(query);
    updateQuery = setQuery;
    return <UsageRecapComposer query={shownQuery} serverId={server.id} onClose={options.onClose ?? (() => {})}
      {...(options.initialOutput ? { initialOutput: options.initialOutput } : {})} />;
  }
  beforeRender?.();
  const screen = await renderScreen(<Host />);
  return { screen, updateQuery };
}

describe('recap composer through authorized query and composition', () => {
  it('composes All personal usage without inventing an epoch start', async () => {
    const reads: ReturnType<typeof UsageAnalyticsQueryRequestSchema.parse>[] = [];
    const { screen } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      reads.push(UsageAnalyticsQueryRequestSchema.parse(request.body));
      return Response.json({ ...accounting, contributions: [{ id: 'all-observation', observedAtMs: Date.now() - 1000,
        eventCount: 1, sessionId: null, turnId: null, agentId: 'codex', modelId: null, machineId: null,
        projectKey: null, workspaceId: null, source: 'native', tokens: accounting.totals.tokens, cost: accounting.totals.cost }] });
    });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    await act(async () => {
      screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-period')!.props.onSelectTab('all');
    });
    await vi.waitFor(() => expect(reads.some(query => query.granularity === 'month')).toBe(true));
    const request = reads.find(query => query.granularity === 'month')!;
    expect(request.dateRange?.endMs).toEqual(expect.any(Number));
    expect(request.dateRange).not.toHaveProperty('startMs');
    await vi.waitFor(() => expect({
      disabled: screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled,
      diagnostics: screen.findAllByType(SurfaceStateCard).flatMap(node => node.props.diagnosticCode ? [node.props.diagnosticCode] : []),
    }).toEqual({ disabled: false, diagnostics: [] }));
  });

  it('preserves a safe rejected compact-wire field behind the existing Details disclosure', async () => {
    const paths: string[] = [];
    const { screen } = await mount(request => {
      paths.push(request.path);
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      return Response.json({ v: 1, results: input.queries.map(query => ({ query, value: { ...accounting,
        totals: { ...accounting.totals, tokens: { ...accounting.totals.tokens, input: 'private-invalid-value' } } } })) });
    });
    await vi.waitFor(() => expect({ paths, states: screen.findAllByType(SurfaceStateCard).map(node => ({
      kind: node.props.kind, title: node.props.title, diagnosticCode: node.props.diagnosticCode,
    })) }).toMatchObject({ states: expect.arrayContaining([expect.objectContaining({
      diagnosticCode: expect.stringContaining('results.0.value.totals.tokens.input'),
    })]) }));
    const details = screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode).join('\n');
    expect(details).toContain('usage_query_result_invalid');
    expect(details).toContain('invalid_type');
    expect(details).not.toContain('private-invalid-value');
  });

  it('composes the Overview compact read with its own selected facts instead of inheriting widget omissions', async () => {
    const requests: unknown[] = [];
    const { screen } = await mount(request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      requests.push(request.body);
      const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const contributions = Array.from({ length: 41 }, (_, index) => ({ id: `recap-event-${index}`, observedAtMs: Date.now() - 1000,
        eventCount: 1,
        sessionId: null, turnId: null, agentId: 'codex', modelId: 'model', machineId: null, projectKey: null,
        workspaceId: null, source: 'native', tokens: accounting.totals.tokens, cost: {
          reportedUsd: [0.10000000000000002, 0.2, 0.3][index] ?? 0, estimatedUsd: 0, currency: 'USD',
          costSource: index === 2 ? 'provider_reported_api_equivalent' as const : 'provider_reported' as const } }));
      const value = repriceUsageAnalyticsResponse({ ...accounting, contributions, totals: { ...accounting.totals, eventCount: 41,
        tokens: { ...accounting.totals.tokens, input: 410, output: 82, total: 492 } } });
      const chunks = [...projectUsageAnalyticsBatchDelivery({ v: 1, results: input.queries.map(query => ({ query, value })) }, input, true)];
      return new Response(chunks.map(chunk => JSON.stringify(chunk) + '\n').join(''),
        { headers: { 'Content-Type': 'application/x-ndjson' } });
    }, normalizeUsageQuery({ includeSeries: false, includeActivity: true, includeInsights: true, includeLeaders: true,
      includeComparison: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false }));
    await vi.waitFor(() => expect({ ready: screen.findByTestId('usage-recap-composer.card') !== null,
      failures: screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode) }).toMatchObject({ ready: true }));
    expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('492');
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
    expect(requests).toHaveLength(1);
    // Linked-work allocation and private interval evidence explicitly admit detail;
    // the parent Overview's broad leaders/calendar and comparison are not acquired.
    expect(requests[0]).toMatchObject({ contributionQueries: [expect.anything()], sessionQueries: [], queries: [expect.objectContaining({
      includeInsights: true, includeLeaders: false, includeSeries: false, includeActivity: false,
      breakdowns: ['agent'],
    })] });
    await act(async () => {
      for (const field of ['activeDays', 'streak', 'agentMix', 'parallel', 'work', 'cache']) {
        screen.findByTestId(`usage-recap-field-${field}.switch`)!.props.onValueChange(false);
      }
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false));
    expect(requests[1]).toMatchObject({ contributionQueries: [], sessionQueries: [], queries: [expect.objectContaining({
      includeInsights: false, includeLeaders: false, includeSeries: false, includeActivity: false, breakdowns: [],
    })] });
    expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('492');
  });
  it('composes private Whole usage independently of public recap policy and page source filters, keeping its admitted preview on source-only updates', async () => {
    const requests: unknown[] = [];
    const { screen, updateQuery } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      requests.push(request.body);
      return Response.json(accounting);
    }, normalizeUsageQuery({ sources: ['native'], execution: 'outside' }), () => {
      storage.setState(current => ({ settings: { ...current.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1, actions: { 'usage.recap.compose': { enabled: false } },
      }) } }));
    });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('12'));
    const beforePageChange = requests.length;
    await act(async () => { updateQuery(normalizeUsageQuery({ sources: ['runtime'], execution: 'unknown' })); });
    expect(requests).toHaveLength(beforePageChange);
    expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('12');
    for (const request of requests) {
      expect(request).not.toHaveProperty('filters.sources');
      expect(UsageAnalyticsQueryRequestSchema.parse(request).filters).not.toHaveProperty('execution');
    }
  });
  it('toggles Whole usage and Happier only through the same composition: Happier only asks for Happier execution, Whole drops it again', async () => {
    const requests: unknown[] = [];
    const { screen } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      requests.push(request.body);
      return Response.json(accounting);
    });
    const source = () => screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-source')!;
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    expect(source().props.activeTabId).toBe('whole_usage');
    expect(source().props.tabs.map((tab: { id: string }) => tab.id)).toEqual(['whole_usage', 'happier_only']);
    const executionOf = (request: unknown) => (UsageAnalyticsQueryRequestSchema.parse(request).filters as { execution?: string } | undefined)?.execution;
    expect(requests.map(executionOf)).toEqual(requests.map(() => undefined));
    const before = requests.length;
    await act(async () => { source().props.onSelectTab('happier_only'); });
    await vi.waitFor(() => expect(requests.slice(before).some(request => executionOf(request) === 'happier')).toBe(true));
    expect(source().props.activeTabId).toBe('happier_only');
    const during = requests.length;
    await act(async () => { source().props.onSelectTab('whole_usage'); });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(during));
    expect(source().props.activeTabId).toBe('whole_usage');
    expect(requests.slice(during).every(request => executionOf(request) === undefined)).toBe(true);
  });
  it.each(['style', 'format'] as const)('admits %s changes through the same composition Action instead of altering an authorized preview locally', async choice => {
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    storage.setState(current => ({ settings: { ...current.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, actions: { 'usage.recap.private.compose': { enabled: false } },
    }) } }));
    await act(async () => {
      if (choice === 'style') screen.findAllByType(SelectionTiles)[0]!.props.onChange('sigil');
      else screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-format')!.props.onSelectTab('story');
    });
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true));
    expect(screen.findByTestId('usage-recap-composer.card')).toBeNull();
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(true);
  });
  it('composes useful accounting with truthful incomplete coverage while private sources remain pending', async () => {
    const heldPrivate = createDeferred<Response>();
    const { screen } = await mount(request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === '/v2/sessions/work-session' ? heldPrivate.promise : undefined,
      normalizeUsageQuery({ session: 'work-session' }));
    try {
      await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
      expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('12');
      expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
    } finally { heldPrivate.resolve(Response.json({ error: 'not_found' }, { status: 404 })); }
  });

  it('retains a ready preview across ambient scope retirement and withdraws it when its Home credential retires', async () => {
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull();
    const server = home!.homes.a!;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    await act(async () => { await TokenStorage.removeCredentialsForServerUrl(server.serverUrl, { serverId: server.id }); });
    expect(screen.findByTestId('usage-recap-composer.card')).toBeNull();
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(true);
  });

  it('settles one admitted composition despite equivalent query and selected-field identity churn', async () => {
    const pending: ReturnType<typeof createDeferred<Response>>[] = [];
    const { screen, updateQuery } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const deferred = createDeferred<Response>();
      pending.push(deferred);
      return deferred.promise;
    });
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const admitted = [...pending];
    await act(async () => {
      updateQuery(normalizeUsageQuery({ agents: ['codex', 'claude', 'claude'] }));
      screen.findByTestId('usage-recap-field-tokens.switch')!.props.onValueChange(true);
    });
    await act(async () => { admitted.forEach(deferred => deferred.resolve(Response.json(accounting))); });
    await vi.waitFor(() => expect({ ready: screen.findByTestId('usage-recap-composer.card') !== null,
      failure: screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode) }).toMatchObject({ ready: true }));
    expect(screen.findByTestId('usage-recap-composer.card')!.props.accessibilityLabel).toContain('12');
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
    pending.forEach(deferred => deferred.resolve(Response.json(accounting)));
  });

  it('keeps the last preview and style tiles while a format switch composes, never blanking them', async () => {
    let hold: ReturnType<typeof createDeferred<Response>> | null = null;
    const { screen } = await mount(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      if (!hold) return Response.json(accounting);
      return hold.promise;
    });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    hold = createDeferred<Response>();
    await act(async () => {
      screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-format')!.props.onSelectTab('story');
    });
    // Still composing the story: the square card and every style tile stay on screen.
    expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull();
    expect(screen.findAllByType(SelectionTiles)[0]!.props.options.every((option: { preview?: unknown }) => option.preview !== undefined)).toBe(true);
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(true);
    await act(async () => { hold!.resolve(Response.json(accounting)); });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false));
  });
  it('exposes a rejected preparation as a recoverable terminal failure', async () => {
    // Invalid clock evidence rejects query preparation before the Action resolves; keep its internal path real.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now');
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined,
      // Only the recap's own period preparation sees the invalid clock; feature decisions keep a real one.
      undefined, () => { clock.mockImplementation(() => new Error().stack?.includes('featureDecision') ? realNow() : Number.NaN); });
    clock.mockRestore();
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true));
    const failure = screen.findAllByType(SurfaceStateCard).find(node => node.props.kind === 'error')!;
    await act(async () => { failure.props.action.onPress(); });
    await vi.waitFor(() => expect({ ready: screen.findByTestId('usage-recap-composer.card') !== null,
      failure: screen.findAllByType(SurfaceStateCard).map(node => node.props.diagnosticCode) }).toMatchObject({ ready: true }));
    expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false);
  });
});

const PAGE = 'https://recap-compose.test/@ada';
function ownerRead(state: 'published' | 'draft') {
  return { kind: 'ready', context: { handle: 'ada', identity: { name: 'Ada' },
    service: { displayName: 'Recap Home', publicBaseUrl: 'https://recap-compose.test' }, urls: {
      page: PAGE, json: `${PAGE}/json`, badgeBase: `${PAGE}/badge`, card: `${PAGE}/card.svg`, og: `${PAGE}/og.png`,
      report: 'mailto:operator@recap-compose.test',
    } }, record: { state, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [],
    query: normalizeUsageQuery({ period: { relative: '90days' } }), snapshot: null, layout: { v: 1, items: [] },
    appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: state === 'published' ? 1 : null, restriction: null } };
}
/** The Home's real embed formatter is the server's; this boundary answers with a recognisable snippet per selection. */
function publicHome(published: boolean, requests: string[]) {
  return (request: Parameters<Parameters<typeof serveAccountHomes>[0]['route']>[0]) => {
    requests.push(`${request.method} ${request.path}${request.url.search}`);
    if (request.path === '/v2/usage/query') return Response.json(accounting);
    if (request.path === '/v1/account/public-profile' && request.method === 'GET') return Response.json(ownerRead(published ? 'published' : 'draft'));
    if (request.path !== '/v1/account/public-profile/embed') return undefined;
    const q = request.url.searchParams;
    if (!published) return Response.json({ kind: 'unavailable', reason: 'not_published' });
    if (q.get('metric') === 'merged-prs') return Response.json({ kind: 'unavailable', reason: 'field_hidden' });
    const image = q.get('kind') === 'badge' ? `${PAGE}/badge/${q.get('metric')}.svg` : `${PAGE}/card.svg`;
    return Response.json({ kind: 'ready', url: `${image}?theme=${q.get('theme')}`,
      snippet: `${q.get('syntax')}|${q.get('kind')}|${q.get('metric') ?? '-'}|${q.get('theme')}`, accessibleLabel: '@ada · Recap Home' });
  };
}
const outputTabs = (screen: Awaited<ReturnType<typeof mount>>['screen']) =>
  screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === 'usage-recap-output');
const choice = (screen: Awaited<ReturnType<typeof mount>>['screen'], prefix: string) =>
  screen.findAllByType(SegmentedTabBar).find(node => node.props.testIDPrefix === prefix)!;
const textOf = (node: { props: { children?: unknown } } | null) => [node?.props.children].flat().join('');

describe('recap composer public outputs', () => {
  it('offers Image, Profile link, Badge and Card only where public profiles are enabled', async () => {
    const { screen } = await mount(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    expect(outputTabs(screen)).toBeUndefined();
    standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined;
    const enabled = await mount(publicHome(true, []), undefined, undefined, { publicProfiles: true });
    await vi.waitFor(() => expect(outputTabs(enabled.screen)?.props.tabs.map((tab: { id: string }) => tab.id))
      .toEqual(['image', 'profile_link', 'badge', 'card']));
    expect(outputTabs(enabled.screen)!.props.activeTabId).toBe('image');
  });

  it('opens on the output its caller asked for, so a just-published page lands on its badge', async () => {
    const { screen } = await mount(publicHome(true, []), undefined, undefined, { publicProfiles: true, initialOutput: 'badge' });
    await vi.waitFor(() => expect(outputTabs(screen)?.props.activeTabId).toBe('badge'));
    expect(screen.findByTestId('usage-recap-composer.card')).toBeNull();
  });

  it('mounts only the selected preview, formats the chosen badge through the embed Action and copies exactly that text', async () => {
    const requests: string[] = [];
    const { screen } = await mount(publicHome(true, requests), undefined, undefined, { publicProfiles: true });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    await act(async () => { screen.findAllByType(SelectionTiles)[0]!.props.onChange('sigil'); });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.save')!.props.accessibilityState.disabled).toBe(false));
    await act(async () => { outputTabs(screen)!.props.onSelectTab('badge'); });
    const composedBefore = requests.filter(line => line.includes('/v2/usage/query')).length;
    expect(screen.findByTestId('usage-recap-composer.card')).toBeNull();
    await vi.waitFor(() => expect(textOf(screen.findByTestId('usage-recap-share.snippet'))).toBe('markdown|badge|tokens|auto'));
    // Light and dark README previews draw the Home's own badge images, never a local look-alike.
    expect(screen.findByTestId('usage-recap-share.preview-light')!.props.source).toMatchObject({ uri: `${PAGE}/badge/tokens.svg?theme=light` });
    expect(screen.findByTestId('usage-recap-share.preview-dark')!.props.source).toMatchObject({ uri: `${PAGE}/badge/tokens.svg?theme=dark` });
    await act(async () => { choice(screen, 'usage-recap-share-syntax').props.onSelectTab('html'); });
    await act(async () => { choice(screen, 'usage-recap-share-theme').props.onSelectTab('dark'); });
    await vi.waitFor(() => expect(textOf(screen.findByTestId('usage-recap-share.snippet'))).toBe('html|badge|tokens|dark'));
    clipboard.mockResolvedValueOnce(undefined);
    await act(async () => { screen.findByTestId('usage-recap-share.copy')!.props.onPress(); });
    await vi.waitFor(() => expect(textOf(screen.findByTestId('usage-recap-share.note'))).toBe('publicIdentity.share.copied'));
    expect(clipboard).toHaveBeenLastCalledWith('html|badge|tokens|dark');
    // A hidden metric explains its prerequisite instead of offering a badge that shows nothing.
    await act(async () => { screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'usage-recap-share.metric')!.props.onSelect('merged-prs'); });
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node =>
      node.props.action?.label === 'publicIdentity.share.previewProfile')).toBe(true));
    expect(screen.findByTestId('usage-recap-share.copy')!.props.accessibilityState.disabled).toBe(true);
    expect(requests.filter(line => line.includes('/v2/usage/query')).length).toBe(composedBefore);
    // Back on Image, the person's earlier selection is still theirs.
    await act(async () => { outputTabs(screen)!.props.onSelectTab('image'); });
    await vi.waitFor(() => expect(screen.findByTestId('usage-recap-composer.card')).not.toBeNull());
    expect(screen.findAllByType(SelectionTiles)[0]!.props.value).toBe('sigil');
  });

  it('never claims a refused copy and keeps the link selectable to copy by hand', async () => {
    const { screen } = await mount(publicHome(true, []), undefined, undefined, { publicProfiles: true });
    await vi.waitFor(() => expect(outputTabs(screen)).toBeDefined());
    await act(async () => { outputTabs(screen)!.props.onSelectTab('profile_link'); });
    await vi.waitFor(() => expect(textOf(screen.findByTestId('usage-recap-share.link'))).toBe(PAGE));
    expect(screen.findByTestId('usage-recap-share.link')!.props.selectable).toBe(true);
    clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    await act(async () => { screen.findByTestId('usage-recap-share.copy')!.props.onPress(); });
    await vi.waitFor(() => expect(textOf(screen.findByTestId('usage-recap-share.note'))).toBe('publicIdentity.share.copyFailed'));
    expect(clipboard).toHaveBeenLastCalledWith(PAGE);
    clipboard.mockResolvedValueOnce(undefined);
    await act(async () => { screen.findByTestId('usage-recap-share.copy')!.props.onPress(); });
    await vi.waitFor(() => expect(textOf(screen.findByTestId('usage-recap-share.note'))).toBe('publicIdentity.share.copied'));
  });

  it('explains an unpublished profile and leads to its preview without publishing anything', async () => {
    const requests: string[] = [];
    const onClose = vi.fn();
    const { screen } = await mount(publicHome(false, requests), undefined, undefined, { publicProfiles: true, onClose });
    await vi.waitFor(() => expect(outputTabs(screen)).toBeDefined());
    for (const tab of ['profile_link', 'badge', 'card'] as const) {
      await act(async () => { outputTabs(screen)!.props.onSelectTab(tab); });
      await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).find(node =>
        node.props.action?.label === 'publicIdentity.share.previewProfile')?.props.title).toBe(`publicIdentity.share.unpublished_${tab}`));
      expect(screen.findByTestId('usage-recap-share.copy')).toBeNull();
    }
    const prerequisite = screen.findAllByType(SurfaceStateCard).find(node => node.props.action?.label === 'publicIdentity.share.previewProfile')!;
    await act(async () => { prerequisite.props.action.onPress(); });
    expect(onClose).toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/settings/account/public-profile');
    // Nothing was written to the public profile: no publish, update or refresh.
    expect(requests.filter(line => line.includes('/v1/account/public-profile') && !line.startsWith('GET'))).toEqual([]);
  });
});
