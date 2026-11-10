import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
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

    it('an announced wait is one quiet line in a body of its own, and wordless among sibling sections', async () => {
        const reachability = { unreachable: true, machineName: 'devbox', lastSeenAt: null, announced: true,
            runtime: { online: false, status: 'offline' as const, label: '', nextAction: null, showStatus: true } };
        const waiting = t('projects.checkouts.waiting', { machine: 'devbox' });
        const body = await renderScreen(<CheckoutUnreachableState reachability={reachability} testID="body" />);
        expect(body.getTextContent()).toContain(waiting);
        // No second cause and no second Retry: the page's line owns both.
        expect(body.getTextContent()).not.toContain(t('common.retry'));
        await body.unmount();
        const section = await renderScreen(<CheckoutUnreachableState reachability={reachability} silent testID="section" />);
        // Wordless on screen, yet spoken: the words are a visually hidden text node, because a label on a
        // role-less box is never read (axe aria-prohibited-attr).
        expect(section.getTextContent()).toBe(waiting);
        expect(section.findHostByTestId('section')?.props.accessibilityLabel).toBeUndefined();
        const spoken = section.root.findAll((node) => node.props.children === waiting && node.props.style !== undefined)[0];
        const flat = Object.assign({}, ...[spoken?.props.style].flat(Infinity).filter(Boolean));
        expect(flat).toMatchObject({ position: 'absolute', width: 1, height: 1, overflow: 'hidden' });
        await section.unmount();
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
});
