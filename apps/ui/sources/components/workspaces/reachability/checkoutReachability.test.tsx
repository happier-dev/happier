import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
const serverId = 'srv_checkout_reachability';
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { CheckoutUnreachableState, useCheckoutReachability } = await import('./checkoutReachability');
const { t } = await import('@/text');

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
        expect(section.getTextContent()).toBe('');
        expect(section.findHostByTestId('section')?.props.accessibilityLabel).toBe(waiting);
        await section.unmount();
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
