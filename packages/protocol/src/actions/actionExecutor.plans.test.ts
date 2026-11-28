import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    executionRunStart: async () => ({}),
    executionRunList: async () => ({}),
    executionRunGet: async () => ({}),
    executionRunSend: async () => ({}),
    executionRunStop: async () => ({}),
    executionRunAction: async () => ({}),
    executionRunWait: async () => ({}),
    sessionOpen: async () => ({}),
    sessionFork: async () => ({}),
    sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}),
    sessionSpawnPicker: async () => ({}),
    pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }),
    serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }),
    agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }),
    sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}),
    sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}),
    sessionModesList: async () => ({ items: [] }),
    sessionTargetPrimarySet: async () => ({}),
    sessionTargetTrackedSet: async () => ({}),
    sessionList: async () => ({}),
    sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}),
    resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

const PLAN = {
  plan: null,
  limits: { sessionRetentionDays: 60, subagentRetentionDays: 7, toolOutputRetentionDays: null, pinnedSessions: 10, artifactStorageBytes: null },
  usage: { pinnedSessions: 2, artifactStorageBytes: null },
  supporter: { active: false, since: null, number: null, recurringSince: null },
  supporterRing: false,
};

describe('createActionExecutor (Plans & Supporter actions)', () => {
  it('opens Discord consent only from an explicit UI button and keeps the URL out of action results', async () => {
    const supporterDiscordLink = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const executor = createExecutor({ supporterDiscordLink });
    for (const surface of ['session_agent', 'mcp', 'cli', undefined] as const) {
      expect((await executor.execute('supporter.discord.link', {}, { surface })).ok).toBe(false);
    }
    expect(supporterDiscordLink).not.toHaveBeenCalled();
    expect(await executor.execute('supporter.discord.link', {}, { surface: 'ui_button' }))
      .toEqual({ ok: true, result: { opened: true } });
    expect(await executor.execute('supporter.discord.link', {}, { surface: 'ui_button' }))
      .toEqual({ ok: false, errorCode: 'discord_link_unavailable', error: 'discord_link_unavailable' });
  });

  it('stars only from an explicit UI invocation with a machine target', async () => {
    const githubStar = vi.fn(async () => ({ status: 'starred' as const }));
    const executor = createExecutor({ githubStar });
    const target = { defaultSessionMachineId: 'machine', serverId: 'home' };
    for (const surface of ['session_agent', 'mcp', 'cli', undefined] as const) {
      expect((await executor.execute('github.star', {}, { ...target, surface })).ok).toBe(false);
    }
    expect(githubStar).not.toHaveBeenCalled();
    expect(await executor.execute('github.star', {}, { ...target, surface: 'ui_button' }))
      .toEqual({ ok: true, result: { status: 'starred' } });
    expect(githubStar).toHaveBeenCalledOnce();
  });
  it('asks agents before shortening local history, with the affected count, and lets extensions run directly', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval' }));
    const localHistory = vi.fn(async ({ request }: { request: { operation: string } }) => request.operation === 'retention.preview'
      ? { ok: true as const, preview: { currentDays: 30, affectedCount: 7, shortening: true } }
      : { ok: true as const });
    const executor = createExecutor({ approvalsCreate, localHistory });
    const source = { machineId: 'machine', providerId: 'claude', source: { kind: 'claudeConfig' } };
    await executor.execute('machines.localHistory.retention.set', { ...source, days: 10 }, { surface: 'session_agent' });
    expect(approvalsCreate.mock.calls).toEqual([[
      expect.objectContaining({ request: expect.objectContaining({ summary: expect.stringContaining('7') }) }),
    ]]);
    expect(localHistory).toHaveBeenCalledTimes(1);

    approvalsCreate.mockClear();
    localHistory.mockResolvedValueOnce({ ok: true, preview: { currentDays: 30, affectedCount: 0, shortening: false } });
    expect((await executor.execute('machines.localHistory.retention.set', { ...source, days: 'never' }, { surface: 'session_agent' })).ok).toBe(true);
    expect(approvalsCreate).not.toHaveBeenCalled();

    await executor.execute('machines.localHistory.letGo', { ...source, items: [{ remoteSessionId: 's1' }] }, { surface: 'mcp' });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
  });

  it('lists leaving sessions and executes all three transcript export modes', async () => {
    const leaving = { count: 1, sessions: [{ id: 's1', title: 'Leaving', leavesAt: 123 }] };
    const adapters: Partial<ActionExecutorDeps> = {
      sessionRetentionLeavingList: async () => leaving,
      sessionExport: async ({ all, seqs }: { all?: true; seqs?: readonly number[] }) => ({
        saved: all ? 'archive' : seqs ? 'selection' : 'session',
      }),
    };
    const executor = createExecutor(adapters);
    const ctx = { surface: 'ui_button' } as const;
    expect(await executor.execute('session.retention.leaving.list', {}, ctx)).toEqual({ ok: true, result: leaving });
    for (const [input, saved] of [
      [{ sessionId: 's1' }, 'session'],
      [{ sessionId: 's1', seqs: [1, 3] }, 'selection'],
      [{ all: true }, 'archive'],
    ] as const) {
      expect(await executor.execute('session.export', { ...input, format: 'json' }, ctx)).toEqual({ ok: true, result: { saved } });
    }
  });

  it('returns the schema-parsed account plan and refuses a malformed one', async () => {
    const ok = createExecutor({ accountPlanGet: async () => PLAN });
    expect(await ok.execute('account.plan.get', {})).toEqual({ ok: true, result: PLAN });

    const malformed = createExecutor({ accountPlanGet: async () => ({ ...PLAN, limits: null }) as never });
    expect((await malformed.execute('account.plan.get', {})).ok).toBe(false);

    const unavailable = createExecutor({ accountPlanGet: async () => ({ ok: false, errorCode: 'plans_unavailable' }) });
    expect(await unavailable.execute('account.plan.get', {})).toEqual({ ok: false, errorCode: 'plans_unavailable', error: 'plans_unavailable' });
  });

  it('passes typed plan refusals through instead of reporting success', async () => {
    const refresh = createExecutor({ billingRefresh: async () => ({ ok: false, errorCode: 'billing_refresh_cloud_only' }) });
    expect(await refresh.execute('billing.refresh', {})).toEqual({
      ok: false,
      errorCode: 'billing_refresh_cloud_only',
      error: 'billing_refresh_cloud_only',
    });

    const supporterRingSet = vi.fn(async () => ({ ok: false as const, errorCode: 'not_a_supporter' as const }));
    const ring = createExecutor({ supporterRingSet });
    expect(await ring.execute('supporter.ring.set', { visible: true })).toEqual({
      ok: false,
      errorCode: 'not_a_supporter',
      error: 'not_a_supporter',
    });
    expect(supporterRingSet).toHaveBeenCalledWith({ visible: true });
  });

  it('lists app icons with locked marks and refuses a set the host or supporter state cannot honour', async () => {
    const listing = {
      supported: true,
      currentIconId: 'default',
      icons: [
        { id: 'default', access: 'everyone' as const, locked: false },
        { id: 'gold', access: 'supporter' as const, locked: true },
      ],
    };
    const icons = createExecutor({ appIconList: async () => listing });
    expect(await icons.execute('app.icon.list', {}, { surface: 'ui_button' })).toEqual({ ok: true, result: listing });

    const appIconSet = vi.fn(async ({ iconId }: { iconId: string }) => iconId === 'gold'
      ? { ok: false as const, errorCode: 'supporter_required' as const }
      : { ok: false as const, errorCode: 'host_unsupported' as const });
    const setter = createExecutor({ appIconSet });
    expect(await setter.execute('app.icon.set', { iconId: 'gold' }, { surface: 'ui_button' })).toEqual({
      ok: false,
      errorCode: 'supporter_required',
      error: 'supporter_required',
    });
    expect(await setter.execute('app.icon.set', { iconId: 'night' }, { surface: 'ui_button' })).toEqual({
      ok: false,
      errorCode: 'host_unsupported',
      error: 'host_unsupported',
    });
    expect(appIconSet).toHaveBeenCalledWith({ iconId: 'gold' });

    const applied = createExecutor({ appIconSet: async ({ iconId }) => ({ iconId }) });
    expect(await applied.execute('app.icon.set', { iconId: 'night' }, { surface: 'ui_button' })).toEqual({ ok: true, result: { iconId: 'night' } });

    // A runtime with no icon host (CLI, daemon) has no executor for these.
    expect((await createExecutor().execute('app.icon.set', { iconId: 'night' }, { surface: 'ui_button' })).errorCode).toBe('unsupported_action');
  });

  it('executes a one-time Supporter checkout on the UI surface only, without returning a URL', async () => {
    const billingCheckoutOpen = vi.fn(async () => 'opened' as const);
    const overrides = { accountPlanGet: async () => PLAN, billingCheckoutOpen };
    const executor = createExecutor(overrides);
    const input = { offerId: 'supporter', interval: 'once', amountMinor: 1000 };

    expect(await executor.execute('billing.checkout.open', input, { surface: 'session_agent' })).toMatchObject({ ok: false });
    expect(billingCheckoutOpen).not.toHaveBeenCalled();
    expect(await executor.execute('billing.checkout.open', input, { surface: 'ui_button' })).toEqual({ ok: true, result: { opened: true } });
    expect(billingCheckoutOpen).toHaveBeenCalledWith(input);
  });

  it('opens billing management without returning the portal URL and preserves code lookup refusals', async () => {
    const billingManageOpen = vi.fn(async () => true);
    const supporterCodeApply = vi.fn(async () => 'not_found' as const);
    const overrides = { accountPlanGet: async () => PLAN, billingManageOpen, supporterCodeApply };
    const executor = createExecutor(overrides);

    expect(await executor.execute('billing.manage.open', {}, { surface: 'ui_button' })).toEqual({ ok: true, result: { opened: true } });
    expect(billingManageOpen).toHaveBeenCalledWith({});
    expect(await executor.execute('supporter.code.apply', { code: '0123456789abcdef0123456789abcdef' }, { surface: 'ui_button' })).toMatchObject({ ok: false, errorCode: 'supporter_code_not_found' });
  });

  it('returns the credits and retention summary through their available read operations', async () => {
    const wall = { schemaVersion: 1, generatedAt: '2026-11-27', total: 1, entries: [{ number: 8, name: 'Myra', since: 2026 }] };
    const summary = { rule: null, windowDays: 14, sessions: 1, ticks: [], pinnedOlderThanCutoff: 0 };
    const overrides = {
      accountPlanGet: async () => PLAN,
      supporterCreditsList: async () => wall,
      sessionRetentionSummaryGet: async () => summary,
    };
    const executor = createExecutor(overrides);

    expect(await executor.execute('supporter.credits.list', {}, { surface: 'ui_button' })).toEqual({ ok: true, result: wall });
    expect(await executor.execute('session.retention.summary.get', {}, { surface: 'ui_button' })).toEqual({ ok: true, result: summary });
  });

  it('scopes pinning and leaving dismissal to the UI server and preserves pin-limit refusal', async () => {
    const overrides = {
      accountPlanGet: async () => PLAN,
      sessionOrganizationPinSet: vi.fn(async () => ({ ok: false as const, errorCode: 'session-pin-limit-exceeded' as const })),
      sessionRetentionLeavingDismiss: vi.fn(async () => ({ dismissed: true as const })),
    };
    const executor = createExecutor(overrides);
    const ctx = { surface: 'ui_button', serverId: 'dev-server' } as const;

    expect(await executor.execute('session.organization.pin.set', { sessionId: 'old-session', pinned: true }, ctx)).toMatchObject({ ok: false, errorCode: 'session-pin-limit-exceeded' });
    expect(overrides.sessionOrganizationPinSet).toHaveBeenCalledWith({ sessionId: 'old-session', pinned: true, serverId: 'dev-server' });
    expect(await executor.execute('session.retention.leaving.dismiss', { through: 42 }, ctx)).toEqual({ ok: true, result: { dismissed: true } });
    expect(overrides.sessionRetentionLeavingDismiss).toHaveBeenCalledWith({ through: 42, serverId: 'dev-server' });
    await executor.execute('session.retention.leaving.dismiss', { through: 42 }, { surface: 'ui_button' });
    expect(overrides.sessionRetentionLeavingDismiss).toHaveBeenLastCalledWith({ through: 42, serverId: null });
  });
});
