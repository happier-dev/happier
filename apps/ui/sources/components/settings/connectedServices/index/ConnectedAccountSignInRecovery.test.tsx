import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { ConnectedAccountIndexRowView, type ConnectedAccountIndexFacts, type ConnectedAccountIndexEntry } from './ConnectedAccountIndexRow';
import { ConnectedAccountCardView } from './ConnectedAccountCard';
import { IconButton } from '@/components/ui/buttons/IconButton';

installConnectedServicesCommonModuleMocks();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const facts: ConnectedAccountIndexFacts = {
    usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
    fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
};

describe('Connected account sign-in recovery', () => {
    it('keeps usage retry, refresh and the default menu independent of account open in the shared card', async () => {
        const open = vi.fn();
        const retry = vi.fn();
        const refresh = vi.fn();
        const defaults = vi.fn();
        const screen = await renderScreen(<ConnectedAccountCardView
            testID="account" title="Work" identityLabel="work@example.test" roles={[{ key: 'pool:work', icon: 'stack', label: 'Work pool', active: true }]}
            signedOut={null} legacyServiceId={null} accountId="work"
            star={<IconButton testID="account:defaults" iconName="star" accessibilityLabel="Defaults" onPress={defaults} />}
            onOpen={open} facts={{ ...facts, planLabel: 'Pro', usage: { kind: 'error', retry, error: 'Sign in again' }, refresh }}
            now={0} legacyServiceMarkId={null} agentIds={[]}
        />);
        expect(screen.getTextContent()).toContain('Work pool');
        expect(screen.getTextContent()).toContain('Pro');
        await screen.pressByTestIdAsync('account:defaults');
        await screen.pressByTestIdAsync('account:refresh');
        await screen.pressByTestIdAsync('account:usage-retry');
        expect(defaults).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(retry).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        const openTarget = screen.findAll(node => node.props.accessibilityLabel === 'Work' && typeof node.props.onPress === 'function').at(-1);
        expect(openTarget).toBeDefined();
        await pressTestInstanceAsync(openTarget);
        expect(open).toHaveBeenCalledOnce();
    });

    for (const view of ['row', 'card'] as const) {
        it(`${view} explains sign-out once and offers an enabled recovery`, async () => {
            const recover = vi.fn();
            const open = vi.fn();
            const entry: ConnectedAccountIndexEntry = {
                testID: 'account', title: 'Work', identityLabel: null, roles: [],
                signedOut: { reason: 'Signed out', onSignInAgain: recover },
                legacyServiceId: null, accountId: 'work', star: null, onOpen: open,
            };
            const screen = await renderScreen(view === 'row'
                ? <ConnectedAccountIndexRowView {...entry} facts={facts} now={0} compact />
                : <ConnectedAccountCardView {...entry} facts={facts} now={0} legacyServiceMarkId={null} agentIds={[]} />);
            expect(screen.getTextContent().split('Signed out')).toHaveLength(2);
            expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.name === 'warning')).toHaveLength(1);
            await screen.pressByTestIdAsync('account:sign-in-again');
            expect(recover).toHaveBeenCalledOnce();
            // The Connect sheet hangs from the pressed button, not from the page centre.
            expect(recover).toHaveBeenCalledWith(expect.objectContaining({ kind: 'view' }));
            expect(open).not.toHaveBeenCalled();
        });
    }

    it('opens the account explanation when sign-in cannot run, instead of a disabled sign-in', async () => {
        const open = vi.fn();
        const screen = await renderScreen(<ConnectedAccountIndexRowView
            testID="account" title="Work" identityLabel={null} roles={[]}
            signedOut={{ reason: 'Signed out', onSignInAgain: null }}
            legacyServiceId={null} accountId="work" star={null} onOpen={open}
            facts={facts} now={0} compact
        />);
        expect(screen.findHostByTestId('account:sign-in-again') !== null).toBe(false);
        await screen.pressByTestIdAsync('account:recovery-details');
        expect(open).toHaveBeenCalledOnce();
    });
});
