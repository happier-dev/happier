import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useUsageHistory } from '@/components/settings/usage/useUsageHistory';
import { createUiClientActionReverseHandler } from './clientActionReverseDispatch';
import { buildUiActionDispatchRequestV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { USAGE_HISTORY_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { usePublishUsageWidgetPageContext, useUsageWidgetPageContext } from '@/components/settings/usage/useUsageWidgetPageContext';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { t } from '@/text';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UsageWidgetBatchProvider, useUsageWidgetBatchHistory, useUsageWidgetModel } from '@/components/settings/usage/widgets/usageWidgetBatch';
import { readUsageWidgetQueryOverrides } from '@/components/settings/usage/usageWidgetPageContext';

// HTTP serves the Account; Socket.IO cannot connect to this constructed Home.
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

describe('Usage history through the shared Account Action', () => {
  it('targets the page period for history when a pinned sibling sorts before its following widget', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-distinct-periods.test', accountId: 'account-a' }],
      route: async request => {
        if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [] });
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        return Response.json({ requests: input.requests.map(row => ({ query: row.query, sessionIds: [] })), results: [] });
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(focused.serverUrl))!;
    const pinned = normalizeUsageQuery({ period: { relative: '90days' } });
    const following = normalizeUsageQuery({ period: { relative: 'all' } });
    const clauses = readUsageWidgetQueryOverrides(pinned);
    let model: ReturnType<typeof useUsageHistory> | undefined;
    const displayed = new Map<'90days' | 'all', typeof pinned>();
    function Body({ period }: { period: '90days' | 'all' }) {
      const { query } = useUsageWidgetModel({ period: { relative: period }, metric: 'tokens' }, 'usage_parallel');
      if (query) displayed.set(period, query);
      return null;
    }
    function History() { model = useUsageWidgetBatchHistory(); return null; }
    const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials,
      children: React.createElement(UsageWidgetBatchProvider, { clauses, inventoryQuery: following,
        children: React.createElement(React.Fragment, null,
          React.createElement(Body, { period: '90days' }), React.createElement(Body, { period: 'all' }), React.createElement(History)),
      }),
    }));
    const dispose: (() => void)[] = [];
    try {
      await expect.poll(() => model?.state).not.toBeNull();
      const { captureUiUsageQueryAccountContext, getUiUsageHistoryState, subscribeUiUsageHistory } = await import('@/sync/api/account/usageQueryResource');
      const context = captureUiUsageQueryAccountContext(credentials)!;
      const reading: string[] = [];
      for (const [period, query] of displayed) dispose.push(subscribeUiUsageHistory(context, query, () => {
        if (getUiUsageHistoryState(context, query).status === 'reading') reading.push(period);
      }));
      await act(async () => { expect(await model!.readNow()).toMatchObject({ ok: true }); });
      expect(reading.length).toBeGreaterThan(0);
      expect(new Set(reading), 'the page Read now targets its own period rather than a lexically earlier pin').toEqual(new Set(['all']));
    } finally { dispose.forEach(stop => stop()); await screen.unmount(); }
  });
  it('retains an admitted page-command history read when Retry retires into Cancel', async () => {
    const held = createDeferred<void>();
    const signals: (AbortSignal | null | undefined)[] = [];
    let requests = 0;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-command-lifetime.test', accountId: 'account-a' }],
      route: async request => {
        if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [] });
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        if (++requests === 1) return Response.json({
          requests: input.requests.map(row => ({ query: row.query, sessionIds: ['retry-session'] })),
          results: [{ sessionId: 'retry-session', detail: { status: 503, body: { error: 'temporarily_unavailable' } },
            turns: { status: 200, body: { v: 1, sessionId: 'retry-session', updatedAt: 1, turns: [] } } }],
        });
        signals.push(request.signal);
        await held.promise;
        return Response.json({ requests: input.requests.map(row => ({ query: row.query, sessionIds: ['retry-session'] })),
          results: [{ sessionId: 'retry-session', detail: { status: 403, body: { error: 'forbidden' } },
            turns: { status: 200, body: { v: 1, sessionId: 'retry-session', updatedAt: 1, turns: [] } } }] });
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(focused.serverUrl))!;
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeTranscriptEvidence: true });
    let model: ReturnType<typeof useUsageHistory> | undefined;
    const mounted: { reader: ReturnType<typeof useOptionalCurrentUiContextReader> } = { reader: null };
    function Page() {
      const authority = React.useMemo(() => captureActiveServerAccountScopeLifetime(), []);
      const page = useUsageWidgetPageContext({ authority });
      model = useUsageHistory({ credentials, query: { query, authority: { serverId: focused.id, accountId: 'account-a' } } });
      const published = usePublishUsageWidgetPageContext({ authority, page, costBasisOptions: [], history: model });
      mounted.reader = useOptionalCurrentUiContextReader();
      return published.publication;
    }
    const screen = await renderMountedCurrentUiContext(React.createElement(Page));
    try {
      await act(async () => { await model!.readNow(); });
      expect(model!.state?.status).toBe('partial');
      const historyRetry = mounted.reader!.readCurrentUiContext()!.commands.find(command =>
        command.title === t('usage.board.page.historyReadCommand'));
      expect(historyRetry).toBeDefined();
      const { storage } = await import('@/sync/domains/state/storage');
      const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
      const settings = storage.getState().settings;
      storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1, actions: { [USAGE_HISTORY_ACTION_IDS.read]: { disabledSurfaces: ['agent'] } },
      }) } });
      try {
        await act(async () => {
          await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
            { commandId: historyRetry!.id }, { surface: 'agent', authority: 'account_automation' });
        });
        await flushHookEffects({ cycles: 10 });
        expect(requests, 'an agent page command cannot acquire history using present-user authority').toBe(1);
        expect(model!.state?.status).toBe('partial');
      } finally { storage.setState({ settings }); }
      await act(async () => {
        expect(await createDefaultActionExecutor().execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
          { commandId: historyRetry!.id }, { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: true });
      });
      await expect.poll(() => signals.length).toBe(1);
      expect(model!.state?.status).toBe('reading');
      expect(mounted.reader!.resolveCurrentUiCommand(historyRetry!.id)).toBeNull();
      expect(signals[0]?.aborted).toBe(false);
      await act(async () => { held.resolve(); });
      await expect.poll(() => model!.state).toMatchObject({ status: 'partial', errorCode: 'forbidden', progress: { failed: 0 } });
    } finally { held.resolve(); await screen.unmount(); }
  });
  it.each(['complete', 'hidden', 'unmounted'] as const)('keeps Read now across a Usage view transition until %s', async ending => {
    const held = createDeferred<void>();
    const signals: (AbortSignal | null | undefined)[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-view-lifetime.test', accountId: 'account-a' }],
      route: async request => {
        if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [] });
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        signals.push(request.signal);
        await held.promise;
        return Response.json({ requests: input.requests.map(row => ({ query: row.query, sessionIds: [] })), results: [] });
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(focused.serverUrl))!;
    const authority = { serverId: focused.id, accountId: 'account-a' };
    const coach = normalizeUsageQuery({ period: { relative: '90days' }, includeTranscriptEvidence: true });
    const work = normalizeUsageQuery({ period: { relative: '90days' }, includeTranscriptEvidence: false });
    let model: ReturnType<typeof useUsageHistory> | undefined;
    function PageRead(props: { query: typeof coach | null }) {
      model = useUsageHistory({ credentials, query: props.query ? { authority, query: props.query } : null });
      return null;
    }
    const page = (query: typeof coach | null, presented = true) => React.createElement(PluginSurfaceFocusEligibilityProvider,
      { active: presented, presentationActive: presented, children: React.createElement(PageRead, { query }) });
    const screen = await renderScreen(page(coach));
    let pending: ReturnType<ReturnType<typeof useUsageHistory>['readNow']> | undefined;
    let unmounted = false;
    try {
      await act(async () => { pending = model!.readNow(); });
      await expect.poll(() => signals.length).toBe(1);
      // The batch has no selected query while the next view's bodies register.
      await screen.update(page(null));
      await screen.update(page(work));
      await flushHookEffects({ cycles: 10 });
      expect(signals[0]?.aborted, 'changing visible Usage bodies retains the admitted page read').toBe(false);
      expect(signals).toHaveLength(1);
      if (ending === 'hidden') await screen.update(page(work, false));
      if (ending === 'unmounted') { await screen.unmount(); unmounted = true; }
      if (ending !== 'complete') expect(signals[0]?.aborted, 'leaving Usage releases the read').toBe(true);
      await act(async () => { held.resolve(); await pending; });
      if (ending === 'complete') expect(await pending).toMatchObject({ ok: true, result: { status: 'complete' } });
    } finally { held.resolve(); await pending; if (!unmounted) await screen.unmount(); }
  });

  it('keeps a focused restricted Action read on its admitted request transport', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-restricted.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
        if (request.path === '/v2/usage/query') {
          if (request.headers.get('x-usage-test-proof') !== 'admitted') return Response.json({ error: 'forbidden' }, { status: 403 });
          return Response.json({ v: 1, totals: { eventCount: 7,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        }
        if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
          const input = UsageSessionEvidenceRequestSchema.parse(request.body);
          return Response.json({ requests: input.requests.map(row => ({ query: row.query, sessionIds: [] })), results: [] });
        }
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const { readUiUsageQueryBatch } = await import('@/sync/api/account/usageQueryResource');
    const account = await captureLazyActionAccountContext(focused.id, undefined, async () => ({ 'x-usage-test-proof': 'admitted' }));
    try {
      const result = await readUiUsageQueryBatch(account, { queries: [normalizeUsageQuery({
        period: { relative: '90days' }, includeWorkEvidence: false, includeComparison: false,
      })] });
      expect(result.results[0]?.accounting?.totals.eventCount).toBe(7);
    } finally { account.dispose(); }
  });

  it('routes an agent history request to the Account client while its Session is not viewed', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-agent.test', accountId: 'account-a' }], route: () => undefined });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const receive = createUiClientActionReverseHandler({ serverId: focused.id, accountId: 'account-a',
      machineId: 'history-machine', isCurrent: () => true });
    // The request crosses the Machine socket boundary; the receiver and its Account executor remain real.
    const request = buildUiActionDispatchRequestV1({ actionId: 'usage.history.read',
      input: { query: normalizeUsageQuery({ period: { relative: '90days' } }), operation: 'status' },
      context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'account-a', defaultSessionId: 'unviewed-agent-session' } });
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ v: 1, execution: { ok: true, result: { status: 'idle', progress: { selected: 0, notRead: 0, completed: 0, failed: 0 } } } });
    expect(home.requests.filter(request => request.path.startsWith('/v2/usage/'))).toHaveLength(0);
  });

  it('retains a background Account partial result after its reverse Action detaches until credential retirement', async () => {
    home = await serveAccountHomes({ homes: [
      { key: 'a', serverUrl: 'https://usage-history-background.test', accountId: 'account-a' },
      { key: 'b', serverUrl: 'https://usage-history-focused.test', accountId: 'account-b' },
    ], route: request => {
      if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
      if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [] });
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) return Response.json({ error: 'unavailable' }, { status: 503 });
      return undefined;
    } });
    const background = home.homes.a!;
    const focused = home.homes.b!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ profileScope: { serverId: focused.id, accountId: 'account-b' } });
    const receive = createUiClientActionReverseHandler({ serverId: background.id, accountId: 'account-a',
      machineId: 'background-history-machine', isCurrent: () => true });
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeWorkEvidence: false });
    const { UsageHistoryReadStateSchema } = await import('@happier-dev/protocol/usage/usageSessionEvidence');
    const invoke = async (operation: 'read' | 'status' | 'cancel', signal = new AbortController().signal) => {
      const result = await receive(buildUiActionDispatchRequestV1({ actionId: 'usage.history.read', input: { query, operation },
        context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'account-a' } }), { signal });
      expect(result.execution.ok).toBe(true);
      if (!result.execution.ok) throw new Error(result.execution.errorCode);
      return UsageHistoryReadStateSchema.parse(result.execution.result);
    };
    const first = new AbortController();
    const settled = await invoke('read', first.signal);
    expect(settled).toMatchObject({ status: 'partial', errorCode: 'usage_session_evidence_read_failed', progress: { failed: 0 } });
    first.abort();
    const beforeObserve = home.requests.length;
    expect(await invoke('status')).toEqual(settled);
    expect(await invoke('cancel')).toEqual(settled);
    expect(home.requests, 'observing settled background work does not acquire data').toHaveLength(beforeObserve);
    // A new read must use its own live invocation, rather than the first caller's ended signal.
    expect(await invoke('read')).toEqual(settled);
    const credentials = (await TokenStorage.getCredentialsForServerUrl(background.serverUrl))!;
    await TokenStorage.removeCredentialsForServerUrl(background.serverUrl, { serverId: background.id });
    await TokenStorage.setCredentialsForServerUrl(background.serverUrl, { serverId: background.id }, credentials);
    expect(await invoke('status')).toEqual({ status: 'idle', progress: { selected: 0, notRead: 0, completed: 0, failed: 0 } });
  });

  it('observes without reading, explicitly reads an empty selection, and retains that owner state for later callers', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-actions.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v1/kv/bulk') return Response.json({ values: [] });
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [] });
        if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
          const input = UsageSessionEvidenceRequestSchema.parse(request.body);
          return Response.json({ requests: input.requests.map(row => ({ query: row.query, sessionIds: [] })), results: [] });
        }
        return undefined;
      } });
    const focused = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
    const caller = { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id,
      expectedAccountId: 'account-a', authority: 'present_user' as const };
    const query = normalizeUsageQuery({ period: { relative: '90days' } });
    const executor = createDefaultActionExecutor();
    const progress = { selected: 0, notRead: 0, completed: 0, failed: 0 };
    const credentials = (await TokenStorage.getCredentialsForServerUrl(focused.serverUrl))!;
    const identity = { query, authority: { serverId: focused.id, accountId: 'account-a' } };
    let renders = 0;
    const hook = await renderHook(({ active }: { active: boolean }) => {
      renders++;
      return useUsageHistory({ credentials, query: identity, active });
    }, { initialProps: { active: true } });
    try {
      expect(hook.getCurrent().state).toEqual({ status: 'idle', progress });
      const dataReads = () => home!.requests.filter(request => request.path.startsWith('/v2/usage/'));
      expect(await executor.execute('usage.history.read', { query, operation: 'status' }, caller))
        .toMatchObject({ ok: true, result: { status: 'idle', progress } });
      expect(dataReads(), 'observing history state must not admit a Usage read').toHaveLength(0);
      const preaborted = new AbortController();
      preaborted.abort();
      await expect(executor.execute('usage.history.read', { query }, { ...caller, signal: preaborted.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(dataReads(), 'a locally cancelled request is never admitted').toHaveLength(0);
      let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
      await act(async () => { result = await hook.getCurrent().readNow(); });
      expect(result).toMatchObject({ ok: true, result: { status: 'complete', progress } });
      expect(hook.getCurrent().state).toEqual({ status: 'complete', progress });
      expect(hook.getCurrent().notRead).toBe(0);
      const afterRead = dataReads().length;
      expect(await createDefaultActionExecutor().execute('usage.history.read', { query, operation: 'status' }, caller))
        .toMatchObject({ ok: true, result: { status: 'complete', progress } });
      expect(await executor.execute('usage.history.read', { query, operation: 'cancel' }, caller))
        .toMatchObject({ ok: true, result: { status: 'complete', progress } });
      expect(dataReads(), 'status and cancelling settled work do not admit new reads').toHaveLength(afterRead);
      await hook.rerender({ active: false });
      const hiddenRenders = renders;
      await executor.execute('usage.history.read', { query }, caller);
      await flushHookEffects({ cycles: 20 });
      expect(renders - hiddenRenders, 'an inactive history hook does not render owner progress').toBe(0);
      await hook.rerender({ active: true });
      expect(hook.getCurrent().state).toEqual({ status: 'complete', progress });
      await act(async () => { result = await hook.getCurrent().cancel(); });
      expect(result).toMatchObject({ ok: true, result: { status: 'complete', progress } });
    } finally { await hook.unmount(); }
  });
});
