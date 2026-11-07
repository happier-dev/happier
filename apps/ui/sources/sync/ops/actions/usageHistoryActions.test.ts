import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useUsageHistory } from '@/components/settings/usage/useUsageHistory';
import { createUiClientActionReverseHandler } from './clientActionReverseDispatch';
import { buildUiActionDispatchRequestV1 } from '@happier-dev/protocol/actions/clientDispatchV1';

// HTTP serves the Account; Socket.IO cannot connect to this constructed Home.
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

describe('Usage history through the shared Account Action', () => {
  it('keeps a focused restricted Action read on its admitted request transport', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-restricted.test', accountId: 'account-a' }],
      route: request => {
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
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-history-agent.test', accountId: 'account-a' }] });
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
    expect(settled).toMatchObject({ status: 'partial', errorCode: 'usage_session_evidence_read_failed', progress: { failed: 1 } });
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
