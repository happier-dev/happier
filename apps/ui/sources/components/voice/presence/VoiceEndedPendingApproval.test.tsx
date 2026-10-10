import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { VoiceSessionEndedAttempt } from '@/voice/session/voiceSessionStore';

import { VoiceEndedPendingApproval } from './VoiceEndedPendingApproval';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';

/**
 * After End, a request the ended conversation left waiting is surfaced from the attempt's captured
 * addresses only — never for another Account, never from a control id — and Review opens that exact
 * session, where the real card decides it by a tap. Ending decided nothing.
 */

const state = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    scope: null as null | { serverId: string; accountId: string },
}));
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
// The persisted session store is the boundary; the request readers beneath it stay real.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: (id: string) => (state.sessions[id] as Session | undefined) ?? null,
        useSessionMessages: () => ({ messages: [], isLoaded: true }),
        useActiveServerAccountScope: () => state.scope,
    });
});

const TARGET = { serverId: 'server-a', sessionId: 'coding-session' } as const;
const CARRIER = { serverId: 'server-a', sessionId: 'voice-carrier' } as const;
const ACCOUNT = { serverId: 'server-a', accountId: 'account-1' } as const;

function pendingSession(id: string): Session {
    return createSessionFixture({
        id,
        serverId: 'server-a',
        active: true,
        presence: 'online',
        updatedAt: 10,
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: 9,
        agentState: {
            controlledByUser: null,
            requests: { 'request-1': { tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: 1 } },
            completedRequests: {},
        },
    } as Partial<Session>);
}

function ended(overrides: Partial<VoiceSessionEndedAttempt> = {}): VoiceSessionEndedAttempt {
    return {
        sessionId: 'control-1',
        adapterId: 'test.adapter',
        startedAt: 1,
        endedAt: 2,
        reason: { kind: 'stopped' },
        conversationSessionAddress: CARRIER,
        targetSessionAddress: TARGET,
        transcriptMode: 'synthetic',
        accountScope: ACCOUNT,
        conversationScope: { kind: 'voice_home' },
        ...overrides,
    } as VoiceSessionEndedAttempt;
}

let screen: RenderScreenResult | null = null;
beforeEach(() => {
    state.sessions = { [TARGET.sessionId]: pendingSession(TARGET.sessionId) };
    state.scope = ACCOUNT;
    routerPush.mockReset();
});
afterEach(async () => {
    await screen?.unmount();
    screen = null;
});

async function render(value: VoiceSessionEndedAttempt) {
    screen = await renderScreen(<VoiceEndedPendingApproval ended={value} testID="pending" />);
    return screen;
}

describe('VoiceEndedPendingApproval', () => {
    it('opens post-End Review in the hosting workspace at the captured Home and Session', async () => {
        function HostedReview() {
            const [destination, setDestination] = React.useState('/settings/voice');
            const navigation = React.useMemo<DestinationNavigation>(() => ({
                push: (href) => setDestination(String(href)),
                replace: (href) => setDestination(String(href)),
                back: () => setDestination('/settings/voice'),
            }), []);
            return <DestinationInstanceHost tabId="voice-ended-tab" ref={{ kind: 'voice', params: {} }}
                pathname={destination} focused visible navigation={navigation}>
                {destination === '/settings/voice' ? <VoiceEndedPendingApproval ended={ended()} testID="pending" />
                    : <Text testID="pending-open-destination">{destination}</Text>}
            </DestinationInstanceHost>;
        }
        screen = await renderScreen(<HostedReview />);
        await screen.pressByTestIdAsync('pending.review');
        expect(screen.findByTestId('pending-open-destination')?.props.children)
            .toBe('/session/coding-session?serverId=server-a');
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('keeps a request the ended conversation left waiting reachable at its exact session', async () => {
        const view = await render(ended());
        view.pressByTestId('pending.review');
        expect(routerPush).toHaveBeenCalledTimes(1);
        expect(String(routerPush.mock.calls[0]![0])).toContain(TARGET.sessionId);
    });

    it('shows nothing for an ended attempt of another Account', async () => {
        state.scope = { serverId: 'server-a', accountId: 'account-2' };
        const view = await render(ended());
        expect(view.findByTestId('pending.review')).toBeNull();
    });

    it('never falls back to the control id when the attempt captured no address', async () => {
        state.sessions = { 'control-1': pendingSession('control-1') };
        const view = await render(ended({ conversationSessionAddress: null, targetSessionAddress: null }));
        expect(view.findByTestId('pending.review')).toBeNull();
    });

    it('stays quiet when nothing is waiting', async () => {
        state.sessions = { [TARGET.sessionId]: createSessionFixture({ id: TARGET.sessionId, serverId: 'server-a' }) };
        const view = await render(ended());
        expect(view.findByTestId('pending.review')).toBeNull();
    });
});
