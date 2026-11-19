import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TranscriptSendToSessionModal } from './TranscriptSendToSessionModal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
afterEach(async () => { await standardCleanup(); await homes.reset(); });

it('offers the incumbent New Session row only when the destination permits creation and resolves without sending', async () => {
    const serverId = await homes.addHome({ name: 'Review destination', serverUrl: 'https://review-destination.test', accountId: 'alice', currentAccount: true });
    const onResolve = vi.fn();
    const props = { sourceServerId: serverId, sessionCandidates: [], onResolve, onClose: vi.fn() };
    const screen = await renderScreen(<TranscriptSendToSessionModal {...props} selectionOnly />);
    try {
        expect(screen.findByTestId('transcript-send-to-session-option-new-session')).toBeNull();
        await screen.update(<TranscriptSendToSessionModal {...props} selectionOnly destination={{
            excludedSessionId: '', capability: 'submitAgentInput', title: 'Apply findings', allowNewSession: true,
        }} />);
        expect(screen.findByTestId('transcript-send-to-session-option-new-session')).not.toBeNull();
        await screen.pressByTestIdAsync('transcript-send-to-session-option-new-session');
        expect(onResolve).toHaveBeenCalledExactlyOnceWith({ kind: 'newSession' });
        expect(homes.requests.some(request => request.method === 'POST' && request.path.includes('/messages'))).toBe(false);
    } finally { await screen.unmount(); }
});
