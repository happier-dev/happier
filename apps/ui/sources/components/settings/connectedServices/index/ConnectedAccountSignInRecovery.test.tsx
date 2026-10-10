import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { ConnectedAccountIndexRowView, type ConnectedAccountIndexFacts, type ConnectedAccountIndexEntry } from './ConnectedAccountIndexRow';
import { ConnectedAccountCardView } from './ConnectedAccountCard';

installConnectedServicesCommonModuleMocks();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const facts: ConnectedAccountIndexFacts = {
    usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null,
    fetchedAt: null, staleSince: null, refreshing: false, refresh: null,
};

describe('Connected account sign-in recovery', () => {
    for (const view of ['row', 'card'] as const) {
        it(`${view} explains sign-out once and offers an enabled recovery`, async () => {
            const recover = vi.fn();
            const entry: ConnectedAccountIndexEntry = {
                testID: 'account', title: 'Work', identityLabel: null, roles: [],
                signedOut: { reason: 'Signed out', onSignInAgain: recover },
                legacyServiceId: null, accountId: 'work', star: null, onOpen: vi.fn(),
            };
            const screen = await renderScreen(view === 'row'
                ? <ConnectedAccountIndexRowView {...entry} facts={facts} now={0} compact />
                : <ConnectedAccountCardView {...entry} facts={facts} now={0} legacyServiceMarkId={null} agentIds={[]} />);
            expect(screen.getTextContent().split('Signed out')).toHaveLength(2);
            expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.name === 'warning')).toHaveLength(1);
            await screen.pressByTestIdAsync('account:sign-in-again');
            expect(recover).toHaveBeenCalledOnce();
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
