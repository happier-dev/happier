import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, createRpcCallError } from '@happier-dev/protocol/rpcErrors';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineGuardViewFixture } from '@/sync/domains/machines/guard/guardViewFixtures';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the Machine network is replaced; credential binding, Actions, the guard and policy stores and the tab run for real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.rpc }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { machineGuardStore } = await import('@/sync/domains/machines/guard/machineGuardStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const { GuardTab } = await import('./GuardTab');
const { Modal } = await import('@/modal');
const { GuardBarAccessory } = await import('./GuardBarAccessory');
const { MachineFreshnessChip } = await import('@/components/machines/page/MachineFreshnessChip');

const GiB = 1024 ** 3;

function MachinePagePresentation({ children }: React.PropsWithChildren) {
    return <ListPresentationProvider value="page">{children}</ListPresentationProvider>;
}

const VIEW = createMachineGuardViewFixture({
    ladder: {
        steps: [
            { rung: 'browsers', enabled: true, status: 'next', freesAboutBytes: 2.3 * GiB,
                candidates: [{ ref: 'browser-1', kind: 'browser', label: 'Browser sidecar', qualifier: '2 tabs · idle 41 min', footprintBytes: 2.3 * GiB }] },
            { rung: 'devServers', enabled: true, status: 'skip', freesAboutBytes: 0, candidates: [] },
            { rung: 'idleSessions', enabled: false, status: 'off', freesAboutBytes: 0, candidates: [] },
        ],
        excluded: [],
        summary: { candidatesBytes: 2.3 * GiB, inUseBytes: 57 * GiB, workingBytes: 9 * GiB, workingSessions: 3, notHappiersBytes: 47 * GiB, leftAloneSessions: 0 },
    },
    idle: [{ sessionRef: 's-1', title: 'Tidy fixtures', agentId: 'claude', status: 'not_yet', idleMs: 3 * 3_600_000 }],
    leftBehind: { count: 2, footprintBytes: 1.1 * GiB },
});

function machine(overrides: Partial<Machine> = {}): Machine {
    return createMachineFixture({ id: 'machine', activeAt: Date.now(), storageMode: 'plain', isShared: false,
        metadata: { host: 'leeroy-mbp', platform: 'darwin', happyCliVersion: '0.3.0', happyHomeDir: '/Users/leeroy/.happier', homeDir: '/Users/leeroy' },
        access: { role: 'manage', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready' },
        daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } } },
        ...overrides });
}

async function mount(options: Readonly<{ params?: React.ComponentProps<typeof GuardTab>['params']; overrides?: Partial<Machine>; barAccessoryShown?: boolean;
    rpc?: (method: string, payload: Record<string, unknown>) => unknown }> = {}) {
    const serverId = await home.addHome({ name: 'Guard Home', serverUrl: `https://guard-tab-${Math.random().toString(36).slice(2)}.test`,
        serverIdentityId: 'srv_guard_tab', accountId: 'owner' });
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine(options.overrides)]);
    transport.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: Record<string, unknown> }) => {
        const answer = options.rpc?.(method, payload);
        if (answer !== undefined) return answer;
        if (method === RPC_METHODS.DAEMON_GUARD_WATCH || method === RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH) return new Promise(() => {});
        if (method === RPC_METHODS.MACHINES_GUARD_GET) return guardAnswer.current;
        if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return { entries: [], counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: Date.now() };
        throw new Error(`unexpected ${method}`);
    });
    const setParams = vi.fn();
    const screen = await renderScreen(<GuardTab serverId={serverId} machineId="machine" machineName="leeroy-mbp" online
        params={options.params ?? { id: 'guard' }} setParams={setParams} barAccessoryShown={options.barAccessoryShown} />, { wrapper: MachinePagePresentation });
    return { screen, setParams, serverId };
}

/** What the machine's Guard read answers by default; a test may change it before reading again. */
const guardAnswer: { current: typeof VIEW } = { current: VIEW };
const before = storage.getState();
function policyControl(screen: Awaited<ReturnType<typeof mount>>['screen'], testID: string) {
    const control = screen.root.findAll(node => node.props.testID === testID && Array.isArray(node.props.items)
        && typeof node.props.onSelect === 'function')[0];
    if (!control) throw new Error(`Policy select unavailable: ${testID}`);
    return control;
}
beforeEach(async () => { await home.reset(); machineGuardStore.reset(); transport.rpc.mockReset(); guardAnswer.current = VIEW; });
afterEach(async () => { standardCleanup(); machineGuardStore.reset(); storage.setState(before); await home.reset(); });

describe('GuardTab', () => {
    it('presents untitled Session ladder and idle rows using the canonical localized fallback', async () => {
        guardAnswer.current = createMachineGuardViewFixture({ ...VIEW,
            policy: { ...VIEW.policy, idleSessions: { ...VIEW.policy.idleSessions, enabled: true } },
            idle: [{ ...VIEW.idle[0]!, title: null }],
            ladder: { ...VIEW.ladder, steps: VIEW.ladder.steps.map(step => step.rung === 'idleSessions'
                ? { ...step, enabled: true, status: 'next' as const, freesAboutBytes: GiB,
                    candidates: [{ ref: 'untitled-session', kind: 'session' as const, label: null, qualifier: 'idle', footprintBytes: GiB }] }
                : step) },
        });
        const { screen } = await mount({ overrides: { metadata: { ...machine().metadata!,
            resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { idleSessions: { enabled: true } } }),
        } } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-candidate-untitled-session')).not.toBeNull()); });
        expect(screen.getTextContent().split(t('session.untitled')).length - 1).toBe(2);
        expect(screen.getTextContent()).not.toContain('3f9a0c21');
    });
    it('says once that nothing automatic has happened, without a zeroed summary or empty filters, and leads back to the rules', async () => {
        const { screen, setParams } = await mount({ params: { id: 'guard', page: 'activity' } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-nothing-yet')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain(t('machineGuard.activity.emptyTitle.7d', { machine: 'leeroy-mbp' }));
        expect(screen.findByTestId('machine-activity-summary')).toBeNull();
        expect(screen.findByTestId('machine-activity-filter:all')).toBeNull();
        expect(screen.findByTestId('machine-activity-earlier')).not.toBeNull();
        await act(async () => screen.pressByTestId('machine-activity-review-rules'));
        expect(setParams).toHaveBeenCalledWith({ id: 'guard' });
    });

    it('previews the same Activity receipts as the detail page when today has no entries', async () => {
        const yesterday = Date.now() - 86_400_000;
        const entries: MachineGuardActivityRowV1[] = Array.from({ length: 30 }, (_, index) => ({
            v: 1, id: `receipt-${index}`, at: yesterday - index * 1000,
            kind: index === 0 ? 'housekeeping' : index === 1 ? 'closed_terminal' : 'stop_failed',
            rule: index === 0 ? 'housekeeping' : index === 1 ? 'idle_terminals' : 'memory_guard',
            outcome: index < 2 ? 'done' : 'failed', attribution: { kind: 'unknown' },
        }));
        const { screen, setParams, serverId } = await mount({ rpc: (method, payload) => {
            if (method !== RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return undefined;
            const selected = payload.range === '7d' && payload.filter === 'all' ? entries : [];
            return { entries: selected, counts: { stopped: 1, cleanedUp: 1, needsLook: 28, others: 0 }, asOf: Date.now() };
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-receipt-0')).not.toBeNull()); });
        expect(screen.findByTestId('machine-guard-all-activity')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-activity-empty')).toBeNull();
        for (const entry of entries.slice(0, 3)) expect(screen.findByTestId(`machine-activity-${entry.id}`)).not.toBeNull();
        expect(screen.findByTestId('machine-activity-receipt-3')).toBeNull();
        const key = { serverId: 'srv_guard_tab', expectedAccountId: 'owner', machineId: 'machine', range: '7d' as const, filter: 'all' as const };
        const preview = machineGuardStore.getActivity(key).list;
        expect(preview?.entries).toEqual(entries);
        await act(async () => screen.pressByTestId('machine-guard-all-activity'));
        expect(setParams).toHaveBeenCalledWith({ id: 'guard', page: 'activity' });
        await screen.update(<GuardTab serverId={serverId} machineId="machine" machineName="leeroy-mbp" online
            params={{ id: 'guard', page: 'activity' }} setParams={setParams} />);
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-receipt-29')).not.toBeNull()); });
        // Both surfaces read the same store query, including receipts outside the Guard view's today window.
        expect(machineGuardStore.getActivity(key).list?.entries).toEqual(preview?.entries);
    });

    it('uses the Activity read state even when the Guard view is ready, retaining receipts across a failed refresh', async () => {
        const first = createDeferred<unknown>();
        const entry: MachineGuardActivityRowV1 = { v: 1, id: 'held-preview', at: Date.now(), kind: 'housekeeping',
            rule: 'housekeeping', outcome: 'done', attribution: { kind: 'unknown' } };
        let reads = 0;
        const { screen } = await mount({ rpc: method => {
            if (method !== RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return undefined;
            if (++reads === 1) return first.promise;
            if (reads === 3) throw new Error('Activity unavailable');
            return { entries: [entry], counts: { stopped: 0, cleanedUp: 1, needsLook: 0, others: 0 }, asOf: Date.now() };
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-live')).not.toBeNull()); });
        expect(screen.findByTestId('machine-guard-activity-loading')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-activity-empty')).toBeNull();
        await act(async () => first.reject(new Error('Activity unavailable')));
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-activity-error')).not.toBeNull()); });
        const key = { serverId: 'srv_guard_tab', expectedAccountId: 'owner', machineId: 'machine', range: '7d' as const, filter: 'all' as const };
        await act(async () => machineGuardStore.retryActivity(key));
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-held-preview')).not.toBeNull()); });
        await act(async () => machineGuardStore.retryActivity(key));
        await act(async () => { await vi.waitFor(() => expect(machineGuardStore.getActivity(key).status).toBe('error')); });
        expect(screen.findByTestId('machine-activity-held-preview')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-all-activity')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-activity-empty')).toBeNull();
    });

    it('accepts Custom values across the policy units and returns failed tool saves to their saved truth', async () => {
        const writes: unknown[] = [];
        const { screen } = await mount({ rpc: (method, payload) => {
            if (method !== RPC_METHODS.MACHINES_RESOURCES_POLICY_SET) return undefined;
            writes.push(payload.patch);
            return { status: 'conflict', policy: MachineResourcesPolicyV1Schema.parse({ v: 1 }), revision: writes.length + 1 };
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-tool-idle-select')).not.toBeNull()); });
        const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValueOnce('5000').mockResolvedValueOnce('1.001 s').mockResolvedValueOnce('12');
        const alert = vi.spyOn(Modal, 'alert').mockImplementation(() => {});
        try {
            await act(async () => { policyControl(screen, 'machine-guard-tool-idle-select').props.onSelect('custom'); });
            await act(async () => { await vi.waitFor(() => expect(alert).toHaveBeenCalled()); });
            expect(writes).toHaveLength(0);
            await act(async () => { policyControl(screen, 'machine-guard-tool-idle-select').props.onSelect('custom'); });
            await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(1)); });
            expect(writes[0]).toEqual({ processes: { toolIdleCloseMs: 1001 } });
            expect(policyControl(screen, 'machine-guard-tool-idle-select').props.selectedId).toBe('300000');
            expect(screen.getTextContent()).toContain(t('machineGuard.saveFailed', { machine: 'leeroy-mbp' }));
            await act(async () => { policyControl(screen, 'machine-guard-browser-limit-select').props.onSelect('custom'); });
            await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(2)); });
            expect(writes[1]).toEqual({ processes: { browserMaxConcurrent: 12 } });
        } finally { prompt.mockRestore(); alert.mockRestore(); }
    });
    it('saves tool idle close and browser concurrency through the sole resources policy Action', async () => {
        const writes: unknown[] = [];
        const { screen } = await mount({ rpc: (method, payload) => {
            if (method !== RPC_METHODS.MACHINES_RESOURCES_POLICY_SET) return undefined;
            writes.push(payload.patch);
            return { status: 'applied', policy: MachineResourcesPolicyV1Schema.parse({ v: 1, ...payload.patch as object }), revision: writes.length + 1 };
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-tool-idle-select')).not.toBeNull()); });
        await act(async () => { policyControl(screen, 'machine-guard-tool-idle-select').props.onSelect('600000'); });
        await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(1)); });
        expect(writes[0]).toEqual({ processes: { toolIdleCloseMs: 600000 } });
        await act(async () => { policyControl(screen, 'machine-guard-browser-limit-select').props.onSelect('4'); });
        await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(2)); });
        expect(writes[1]).toEqual({ processes: { browserMaxConcurrent: 4 } });
        await act(async () => { policyControl(screen, 'machine-guard-browser-limit-select').props.onSelect('null'); });
        await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(3)); });
        expect(writes[2]).toEqual({ processes: { browserMaxConcurrent: null } });
    });
    it('keeps feedback on both rows when two queued local saves encounter genuine external conflicts', async () => {
        let writes = 0;
        const { screen } = await mount({ rpc: method => {
            if (method !== RPC_METHODS.MACHINES_RESOURCES_POLICY_SET) return undefined;
            writes += 1;
            return { status: 'conflict', policy: MachineResourcesPolicyV1Schema.parse({ v: 1 }), revision: writes + 1 };
        } });
        await act(async () => {
            screen.findByTestId('machine-guard-memory-switch')!.props.onValueChange(true);
            screen.findByTestId('machine-guard-idle-switch')!.props.onValueChange(true);
            await vi.waitFor(() => expect(writes).toBe(2));
        });
        const failure = t('machineGuard.saveFailed', { machine: 'leeroy-mbp' });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent().split(failure).length - 1).toBeGreaterThanOrEqual(2)); });
        expect(screen.findByTestId('machine-guard-memory-switch')?.props.value).toBe(false);
        expect(screen.findByTestId('machine-guard-idle-switch')?.props.value).toBe(false);
    });

    it.each([false, true])('uses the selected Activity query as freshness and keeps its receipts through failure and recovery (bar=%s)', async barAccessoryShown => {
        const entry: MachineGuardActivityRowV1 = { v: 1, id: 'activity-retained', at: 1000, kind: 'stopped_session', rule: 'idle_sessions',
            subject: { kind: 'session', sessionId: 's-1', title: 'Retained receipt' }, outcome: 'done', attribution: { kind: 'unknown' } };
        let fail = false;
        let asOf = 2000;
        const { screen } = await mount({ barAccessoryShown, params: { id: 'guard', page: 'activity' }, rpc: method => {
            if (method !== RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return undefined;
            if (fail) throw new Error('Activity read failed');
            return { entries: [entry], counts: { stopped: 1, cleanedUp: 0, needsLook: 0, others: 0 }, asOf };
        } });
        const freshness = () => screen.root.findAllByType(MachineFreshnessChip)[0]?.props.freshness;
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-activity-retained')).not.toBeNull()); });
        expect(freshness()).toMatchObject({ kind: 'live' });
        for (const filter of ['all', 'stopped'] as const) {
            if (filter !== 'all') {
                await act(async () => screen.pressByTestId('machine-activity-filter:stopped'));
                await act(async () => { await vi.waitFor(() => expect(freshness()).toMatchObject({ kind: 'live' })); });
            }
            fail = true;
            await act(async () => machineGuardStore.retryActivity({ serverId: 'srv_guard_tab', expectedAccountId: 'owner', machineId: 'machine', range: '7d', filter }));
            await act(async () => { await vi.waitFor(() => expect(freshness()).toMatchObject({ kind: 'stale', at: asOf })); });
            expect(screen.findByTestId('machine-activity-activity-retained')).not.toBeNull();
            fail = false; asOf += 1000;
            await act(async () => screen.pressByTestId('machine-vitals-retry'));
            await act(async () => { await vi.waitFor(() => expect(freshness()).toMatchObject({ kind: 'live' })); });
        }
    });

    it('does not label an Activity page Live from the unrelated Guard watch', async () => {
        const { serverId } = await mount({ barAccessoryShown: true });
        const screen = await renderScreen(<GuardBarAccessory serverId={serverId} machineId="machine" online params={{ id: 'guard', page: 'activity' }} />);
        expect(screen.root.findAllByType(MachineFreshnessChip)).toHaveLength(0);
        await screen.unmount();
    });

    it('previews what the off memory guard would do with real candidates, and says each rule’s present state', async () => {
        const { screen } = await mount();
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-ladder')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toContain('If this were on and leeroy-mbp ran short on memory right now, Happier would:');
        expect(text).toContain('Close idle browsers');
        expect(text).toContain('frees about 2.3 GB');
        expect(text).toContain('Browser sidecar');
        expect(text).toContain('nothing eligible');
        expect(text).toContain('That is up to 2.3 GB of the 57 GB in use. The rest is 3 sessions at work, which are never touched and 47 GB that isn’t Happier’s.');
        expect(text).toContain('Off. Nothing is stopped for memory.');
        expect(text).toContain('Off. 1 session here has been idle for over 2 h.');
        expect(text).toContain('Off. 2 are running on leeroy-mbp right now, holding 1.1 GB.');
        expect(text).toContain('Linux only. macOS can’t cap what a session and its processes use together.');
        expect(text).toContain('Nothing yet. Whatever Happier stops on leeroy-mbp by itself is listed here with the reason and a way back.');
        expect(screen.findByTestId('machine-guard-activity-empty')).not.toBeNull();
        // Off, the ladder is a preview: no step switches.
        expect(screen.findByTestId('machine-guard-step-browsers-switch')).toBeNull();
    });

    it('turns the memory guard on through the machine’s one resources policy', async () => {
        const writes: unknown[] = [];
        const { screen } = await mount({ rpc: (method, payload) => {
            if (method !== RPC_METHODS.MACHINES_RESOURCES_POLICY_SET) return undefined;
            writes.push(payload.patch);
            const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: true } } });
            return { status: 'applied', policy, revision: 2 };
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-memory-switch')).not.toBeNull()); });
        await act(async () => { screen.findByTestId('machine-guard-memory-switch')!.props.onValueChange(true); });
        await act(async () => { await vi.waitFor(() => expect(writes).toHaveLength(1)); });
        expect(writes[0]).toEqual({ guard: { memoryGuard: { enabled: true } } });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('Act when memory pressure is')); });
        // Saved, but the machine's last answer still runs it off: the row says so until the machine answers with it on.
        expect(screen.getTextContent()).toContain('Saved. leeroy-mbp hasn’t applied it yet.');
        guardAnswer.current = createMachineGuardViewFixture({ ...VIEW, policy: { ...VIEW.policy, memoryGuard: { ...VIEW.policy.memoryGuard, enabled: true } } });
        await act(async () => { machineGuardStore.retryView({ machineId: 'machine', serverId: 'srv_guard_tab', expectedAccountId: 'owner' }); });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('Watching. Acts when pressure stays critical for 2 min.')); });
        expect(screen.getTextContent()).not.toContain('hasn’t applied it yet');
    });

    it('keeps every rule\u2019s control in place while a change is saving, so nothing swaps to text and back', async () => {
        let finish: (answer: unknown) => void = () => {};
        const saved = new Promise(resolve => { finish = resolve; });
        const { screen } = await mount({ rpc: method => method === RPC_METHODS.MACHINES_RESOURCES_POLICY_SET ? saved : undefined });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-memory-switch')).not.toBeNull()); });
        await act(async () => { screen.findByTestId('machine-guard-memory-switch')!.props.onValueChange(true); });
        expect(screen.findByTestId('machine-guard-memory-switch')!.props.value).toBe(true);
        expect(screen.findByTestId('machine-guard-idle-switch')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-terminals-switch')).not.toBeNull();
        await act(async () => { finish({ status: 'applied', policy: MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: true } } }), revision: 2 }); });
    });

    it('draws no \u201cup to 0 B of the 0 B in use\u201d line when no step has anything to stop', async () => {
        const { screen } = await mount({ rpc: method => method === RPC_METHODS.MACHINES_GUARD_GET ? createMachineGuardViewFixture() : undefined });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-ladder')).not.toBeNull()); });
        expect(screen.findByTestId('machine-guard-ladder-summary')).toBeNull();
        expect(screen.getTextContent()).toContain('nothing eligible');
    });

    it('says \u201cUnavailable\u201d for keep awake on a machine with no way to stay awake, instead of a lone Off choice', async () => {
        const base = createMachineGuardViewFixture();
        const { screen } = await mount({ rpc: method => method === RPC_METHODS.MACHINES_GUARD_GET
            ? { ...base, state: { ...base.state, capabilities: { ...base.state.capabilities, keepAwake: { modes: ['off'], unavailableReason: 'no_inhibitor' } } } } : undefined });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('This machine offers no way to stay awake.')); });
        expect(screen.findByTestId('machine-guard-awake:off')).toBeNull();
        expect(screen.findByTestId('machine-guard-awake')).not.toBeNull();
    });

    it('shows the machine is held awake with no working session, and withdraws that status when the holder exits', async () => {
        guardAnswer.current = createMachineGuardViewFixture({ state: { ...VIEW.state, keepAwakeHolding: true }, keepAwake: { holding: true, workingSessions: 0 } });
        const { screen } = await mount();
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).toContain('Awake now. Ready for your next session.')); });
        guardAnswer.current = createMachineGuardViewFixture({ keepAwake: { holding: false, workingSessions: 0 } });
        await act(async () => { machineGuardStore.retryView({ machineId: 'machine', serverId: 'srv_guard_tab', expectedAccountId: 'owner' }); });
        await act(async () => { await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Awake now. Ready for your next session.')); });
    });

    it('says Live through the page\u2019s one freshness chip, in the body only where the tab bar has no end for it', async () => {
        const phone = await mount();
        await act(async () => { await vi.waitFor(() => expect(phone.screen.findByTestId('machine-guard-live')).not.toBeNull()); });
        expect(phone.screen.getTextContent()).toContain('Live');
        await home.reset(); machineGuardStore.reset();
        const wide = await mount({ barAccessoryShown: true });
        await act(async () => { await vi.waitFor(() => expect(wide.screen.findByTestId('machine-guard-ladder')).not.toBeNull()); });
        expect(wide.screen.findByTestId('machine-guard-live')).toBeNull();
    });

    it('keeps the last Guard answer under an \u201cAs of\u201d chip with Retry when a later read fails', async () => {
        let reads = 0;
        const { screen } = await mount({ rpc: method => {
            if (method !== RPC_METHODS.MACHINES_GUARD_GET) return undefined;
            reads += 1;
            if (reads > 1) throw new Error('unreachable');
            return VIEW;
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-live')).not.toBeNull()); });
        await act(async () => { machineGuardStore.retryView({ machineId: 'machine', serverId: 'srv_guard_tab', expectedAccountId: 'owner' }); });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-stale')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('Browser sidecar');
    });

    it('says it is still checking while the first Guard read is out, and claims no present fact until it answers', async () => {
        const { screen } = await mount({ rpc: method => method === RPC_METHODS.MACHINES_GUARD_GET || method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST ? new Promise(() => {}) : undefined });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-checking')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toContain('Checking…');
        expect(text).not.toContain('Live');
        // The rules read from the saved settings; what is idle or left behind right now is not known yet.
        expect(text).toContain('Off. Idle sessions keep running.');
        expect(text).not.toContain('No session here has been idle for long');
        expect(screen.findByTestId('machine-guard-ladder-reserved')).not.toBeNull();
        // "Nothing yet" claims an answered read; the first one is still out.
        expect(screen.findByTestId('machine-guard-activity-empty')).toBeNull();
        expect(screen.findByTestId('machine-guard-activity-loading')).not.toBeNull();
    });

    it('keeps the held answer under \u201cAs of \u2026 \u00b7 Checking\u2026\u201d while a later read is still out', async () => {
        let reads = 0;
        const { screen } = await mount({ rpc: method => {
            if (method !== RPC_METHODS.MACHINES_GUARD_GET) return undefined;
            reads += 1;
            return reads > 1 ? new Promise(() => {}) : VIEW;
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-live')).not.toBeNull()); });
        await act(async () => { machineGuardStore.retryView({ machineId: 'machine', serverId: 'srv_guard_tab', expectedAccountId: 'owner' }); });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-checking')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toMatch(/As of .+·.*Checking…/);
        expect(text).toContain('Browser sidecar');
    });

    it('says a saved rule the machine has not applied yet, instead of passing the setting off as what runs', async () => {
        const running = createMachineGuardViewFixture({ ...VIEW, policy: { ...VIEW.policy, idleSessions: { ...VIEW.policy.idleSessions, enabled: true } } });
        const { screen } = await mount({ rpc: method => method === RPC_METHODS.MACHINES_GUARD_GET ? running : undefined });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-ladder')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('Saved. leeroy-mbp hasn’t applied it yet.');
    });

    it.each([0, Date.UTC(2026, 9, 24, 12)])('reads offline rules with the last-known timestamp (%s)', async activeAt => {
        const { screen } = await mount({ overrides: { active: false, activeAt }, barAccessoryShown: true });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-offline')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain(t('machineGuard.states.offlineBody', {
            time: activeAt > 0 ? formatAsOfTime(activeAt) : t('machineGuard.states.lastKnown'),
        }));
        expect(screen.findByTestId('machine-guard-left-behind:off')).toBeNull();
        expect(screen.findByTestId('machine-guard-left-behind')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-activity-empty')).toBeNull();
        expect(screen.findByTestId('machine-guard-activity-offline')).not.toBeNull();
        // The page header already says it is offline: the tab says what that means in the page's one offline notice.
        const { MachineOfflineNotice } = await import('@/components/machines/page/MachineOfflineNotice');
        expect(screen.findAllByType(MachineOfflineNotice)).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain(t('machineGuard.states.offlineTitle', { machine: 'leeroy-mbp' }));
    });

    it('keeps the saved rules under one line saying the first read failed, instead of emptying the tab', async () => {
        const { screen } = await mount({ rpc: method => { if (method === RPC_METHODS.MACHINES_GUARD_GET || method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) throw new Error('unreachable'); return undefined; } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-error')).not.toBeNull()); });
        expect(screen.findByTestId('machine-guard-idle-switch')).not.toBeNull();
        expect(screen.findByTestId('machine-guard-ladder-reserved')).toBeNull();
        // A failed read is not an empty Activity, and the ladder does not stay on its reserved Checking skeleton.
        expect(screen.findByTestId('machine-guard-activity-empty')).toBeNull();
        expect(screen.findByTestId('machine-guard-activity-error')).not.toBeNull();
    });

    it('says what is missing when the machine runs an older Happier', async () => {
        const { screen } = await mount({ rpc: method => {
            // An older daemon has no such method: the scoped transport rejects with the RPC not-found error.
            if (method === RPC_METHODS.MACHINES_GUARD_GET) throw createRpcCallError({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            return undefined;
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-guard-older')).not.toBeNull()); });
        expect(screen.getTextContent()).toContain('Let leeroy-mbp look after itself');
    });

    it('lists Activity receipts with their reason and way back; an undone one is struck and offers none', async () => {
        const entry = (overrides: Partial<MachineGuardActivityRowV1>): MachineGuardActivityRowV1 => ({
            v: 1, id: 'e1', at: Date.now() - 60_000, kind: 'stopped_session', rule: 'idle_sessions',
            subject: { kind: 'session', sessionId: 's-1', title: 'Review #2481' }, freedBytes: 540 * 1024 ** 2, outcome: 'done',
            wayBack: [{ label: 'resume', actionId: 'session.open', input: { sessionId: 's-1' } }], attribution: { kind: 'unknown' }, ...overrides,
        } as MachineGuardActivityRowV1);
        const list = { entries: [entry({}), entry({ id: 'e2', undoneAt: Date.now() })],
            counts: { stopped: 2, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: Date.now() };
        const undo: unknown[] = [];
        const { screen } = await mount({ params: { id: 'guard', page: 'activity' }, rpc: (method, payload) => {
            if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) return list;
            if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO) { undo.push(payload.entryId); return { ok: true }; }
            return undefined;
        } });
        await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-e1')).not.toBeNull()); });
        const text = screen.getTextContent();
        expect(text).toContain('Stopped “Review #2481”');
        expect(text).toContain('540 MB freed');
        expect(text).toContain('It wakes on your next message');
        expect(screen.findByTestId('machine-activity-e1-resume')).not.toBeNull();
        expect(screen.findByTestId('machine-activity-e2-resume')).toBeNull();
        await act(async () => { screen.pressByTestId('machine-activity-e1-resume'); });
        await act(async () => { await vi.waitFor(() => expect(undo).toEqual(['e1'])); });
    });
});
