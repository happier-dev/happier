import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// The sync runtime is created at app start; its machine refresh is the server request behind Try again.
const refreshMachinesThrottled = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/sync/sync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/sync')>()),
    sync: { refreshMachinesThrottled },
}));

const home = createHomeGovernanceHarness();
const serverId = 'srv_checkout_reachability';
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { CheckoutUnreachableState, useCheckoutReachability } = await import('./checkoutReachability');
const { checkoutMachineScopeOfProject } = await import('./checkoutReachabilityModel');
const { t } = await import('@/text');
const { formatLastSeen } = await import('@/utils/sessions/sessionUtils');

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Reachability Home', serverUrl: 'https://reachability.example.test',
        serverIdentityId: serverId, accountId: 'account-a' });
});

afterEach(async () => {
    standardCleanup();
    await home.reset();
});

describe('checkout reachability', () => {

    it('keeps mounted page and later Files pane ages current from the same offline heartbeat', async () => {
        const { useCheckoutReachabilityPresentation } = await import('./checkoutReachabilityModel');
        const heartbeat = Date.parse('2026-11-23T09:00:00Z');
        const presence = { name: 'devbox', homeDir: null, reachability: 'unreachable' as const,
            presenceOnline: false, lastSeenAt: heartbeat };
        vi.useFakeTimers();
        vi.setSystemTime(heartbeat + 9 * 60_000);
        const page = await renderHook(() => useCheckoutReachabilityPresentation(null, presence));
        let files: typeof page | undefined;
        try {
            expect(page.getCurrent().runtime.label).toContain(t('time.minutesAgo', { count: 9 }));
            await act(async () => { vi.advanceTimersByTime(60_000); });
            await act(async () => { vi.advanceTimersByTime(60_000); });
            files = await renderHook(() => useCheckoutReachabilityPresentation(null, presence));
            expect(page.getCurrent().runtime.label).toBe(files.getCurrent().runtime.label);
            expect(page.getCurrent().runtime.label).toContain(t('time.minutesAgo', { count: 11 }));
        } finally {
            await files?.unmount();
            await page.unmount();
            vi.useRealTimers();
        }
    });

    it('withdraws age wakes while hidden and resumes with the current age', async () => {
        const { useCheckoutReachabilityPresentation } = await import('./checkoutReachabilityModel');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const heartbeat = Date.parse('2026-11-23T09:00:00Z');
        const presence = { name: 'devbox', homeDir: null, reachability: 'unreachable' as const,
            presenceOnline: false, lastSeenAt: heartbeat };
        let setPresented!: React.Dispatch<React.SetStateAction<boolean>>;
        let renders = 0;
        function Wrapper(props: React.PropsWithChildren) {
            const [presented, set] = React.useState(true);
            setPresented = set;
            return <PluginSurfaceFocusEligibilityProvider active={presented}>{props.children}</PluginSurfaceFocusEligibilityProvider>;
        }
        vi.useFakeTimers();
        vi.setSystemTime(heartbeat + 9 * 60_000);
        const page = await renderHook(() => {
            renders += 1;
            return useCheckoutReachabilityPresentation(null, presence);
        }, { wrapper: Wrapper });
        try {
            await act(async () => { setPresented(false); });
            renders = 0;
            await act(async () => { vi.advanceTimersByTime(2 * 60_000); });
            expect(renders).toBe(0);
            await act(async () => { setPresented(true); });
            expect(page.getCurrent().runtime.label).toContain(t('time.minutesAgo', { count: 11 }));
        } finally {
            await page.unmount();
            vi.useRealTimers();
        }
    });

    it('holds no age wake once the last-seen label has become an absolute date', async () => {
        const { useCheckoutReachabilityPresentation } = await import('./checkoutReachabilityModel');
        const heartbeat = Date.parse('2026-11-10T09:00:00Z');
        const presence = { name: 'devbox', homeDir: null, reachability: 'unreachable' as const,
            presenceOnline: false, lastSeenAt: heartbeat };
        vi.useFakeTimers();
        vi.setSystemTime(heartbeat + 7 * 86_400_000);
        const page = await renderHook(() => useCheckoutReachabilityPresentation(null, presence));
        try {
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await page.unmount();
            vi.useRealTimers();
        }
    });

    it('an announced wait among sibling sections is one visible line naming the Machine it shows with (owner P1 11-15)', async () => {
        const reachability = { unreachable: true, machineName: 'NLDW3-5-36-33', lastSeenAt: null, announced: true,
            runtime: { online: false, status: 'offline' as const, label: '', nextAction: null, showStatus: true } };
        const line = t('projects.checkouts.shownWhenReachable', { machine: 'NLDW3-5-36-33' });
        const section = await renderScreen(<CheckoutUnreachableState reachability={reachability} silent testID="section" />);
        try {
            // One line, seen as well as heard: no second cause and no Retry (the page's notice owns both).
            expect(section.getTextContent()).toBe(line);
            const shown = section.root.findAll((node) => node.props.children === line && node.props.style !== undefined)[0];
            const flat = Object.assign({}, ...[shown?.props.style].flat(Infinity).filter(Boolean));
            expect(flat.position).not.toBe('absolute');
            expect(flat.width).not.toBe(1);
        } finally {
            await section.unmount();
        }
    });

    it('an announced wait is one quiet line in a body of its own', async () => {
        const reachability = { unreachable: true, machineName: 'devbox', lastSeenAt: null, announced: true,
            runtime: { online: false, status: 'offline' as const, label: '', nextAction: null, showStatus: true } };
        const waiting = t('projects.checkouts.waiting', { machine: 'devbox' });
        const body = await renderScreen(<CheckoutUnreachableState reachability={reachability} testID="body" />);
        expect(body.getTextContent()).toContain(waiting);
        // No second cause and no second Retry: the page's line owns both.
        expect(body.getTextContent()).not.toContain(t('common.retry'));
        await body.unmount();
    });
    it('an unannounced offline checkout is the shared out-of-reach state: when it was seen, what returns, and Try again', async () => {
        const lastSeenAt = Date.now() - 3 * 60 * 60 * 1000;
        const reachability = { unreachable: true, machineName: 'leeroy-mbp', lastSeenAt, announced: false,
            runtime: { online: false, status: 'offline' as const, label: 'Offline · last seen 3 hours ago', nextAction: 'retry' as const, showStatus: true } };
        const screen = await renderScreen(<CheckoutUnreachableState reachability={reachability}
            returns={t('projects.checkouts.filesReturn')} testID="files" />);
        try {
            const text = screen.getTextContent();
            expect(text).toContain(t('projects.checkouts.outOfReach', { machine: 'leeroy-mbp' }));
            expect(text).toContain(t('projects.checkouts.lastSeen', { when: formatLastSeen(lastSeenAt) }));
            expect(text).toContain(t('projects.checkouts.filesReturn'));
            // One message: the bare presence label is not the headline.
            expect(text).not.toContain('Offline · last seen');
            await screen.pressByTestIdAsync('files-action');
            await waitForHomeGovernance(() => expect(refreshMachinesThrottled).toHaveBeenCalledWith({ staleMs: 0, force: true }));
        } finally {
            await screen.unmount();
        }
    });
    it('names the Machine in its sentences only once its name is known', async () => {
        // A Machine whose details are still loading has a placeholder title, never a name for a sentence
        // ("Reading it from Loading…"): the sentence says "this machine" until the name arrives.
        const named = createMachineFixture({ id: 'machine', activeAt: Date.now() });
        storage.getState().applyMachines([{ ...named, metadata: null, availability: undefined }], true, { sourceServerId: serverId });
        const hook = await renderHook(() => useCheckoutReachability({ serverId, machineId: 'machine' }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().machineName).not.toBe('machine'));
            expect(hook.getCurrent().machineName).toBe(t('machine.thisMachineInSentence'));
            storage.getState().applyMachines([{ ...named, metadata: { ...named.metadata!, displayName: 'Build box' } }], true, { sourceServerId: serverId });
            await waitForHomeGovernance(() => expect(hook.getCurrent().machineName).toBe('Build box'));
        } finally { await hook.unmount(); }
    });
    it('an attached workspace Project is offline when the controller it is reached via is offline (lab project-offline)', async () => {
        // A managed ref has no Machine of its own; its checkout is read through the controller, so that is the Machine
        // the page announces. The raw ref names no Machine and would never read as offline.
        const controller = createMachineFixture({ id: 'controller', activeAt: Date.now() - 60 * 60 * 1000 });
        storage.getState().applyMachines([{ ...controller, active: false,
            metadata: { ...controller.metadata!, displayName: 'nl3' } }], true, { sourceServerId: serverId });
        const ref = { v: 2, kind: 'managed', id: 'checkout', serverId, managedId: 'api-dev', rootPath: '/home/coder/api',
            createdAtMs: 1, controller: { machineId: 'controller', installationId: 'installation' } } satisfies WorkspaceRefV1;
        const hook = await renderHook(() => useCheckoutReachability(checkoutMachineScopeOfProject(ref)));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().unreachable).toBe(true));
            expect(hook.getCurrent().machineName).toBe('nl3');
        } finally { await hook.unmount(); }
    });
});
