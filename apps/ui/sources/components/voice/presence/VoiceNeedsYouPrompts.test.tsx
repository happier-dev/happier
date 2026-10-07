import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';

import { VoiceNeedsYouPrompts } from './VoiceNeedsYouPrompts';

// External enriched-markdown animation SDK: this context test uses plain, still tool text.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (input: { text: string; startOffset: number }) => [{ ...input, animated: false }],
}));
const sessionRpcTransport = vi.hoisted(() => vi.fn(async (
    _params: Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc')['sessionRpcWithServerScope']>[0],
) => undefined));
// Permission custody stays real; only the server socket transport is replaced.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return installServerScopedSessionRpcModuleMock({
        sessionRpcWithServerScope: async <R,>(params: Parameters<typeof sessionRpcTransport>[0]): Promise<R> => {
            if (params.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) throw new Error('Unexpected request in Voice permission fixture');
            await sessionRpcTransport(params);
            // This external RPC's acknowledgement has no payload; R is chosen by its caller.
            return undefined as R;
        },
    })(importOriginal);
});

const initialState = storage.getState();
let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    storage.setState(initialState);
});

describe('VoiceNeedsYouPrompts', () => {
    it.each([false, true])('answers the exact conversation independently of an unrelated surrounding transcript (%s)', async (surrounded) => {
        sessionRpcTransport.mockClear();
        await loadSyncSingletonForTests();
        const address = { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice-needs-you' };
        const session = createSessionFixture({
            id: address.sessionId, serverId: address.serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1,
            agentState: { requests: { 'voice-request': { tool: 'Bash', arguments: { command: 'git status' }, createdAt: 1 } } },
        });
        // The real Session producer also materializes the server-scoped access row.
        storage.getState().applySessions([session]);
        storage.setState({ sessionMessages: { ...storage.getState().sessionMessages, [session.id]: createSessionMessagesFixture({ isLoaded: true }) } });

        const prompts = <VoiceNeedsYouPrompts address={address} testID="voice-pending" />;
        const unrelated = createReadOnlySessionTranscriptSource({ sessionId: 'other-session', messages: [], reducerState: null, metadata: null, agentState: null });
        screen = await renderScreen(surrounded ? <SessionTranscriptSourceProvider source={unrelated}>{prompts}</SessionTranscriptSourceProvider> : prompts);

        expect(screen.findByTestId('permission-prompt-card')).not.toBeNull();
        expect(screen.getTextContent()).toContain('git status');
        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId: address.sessionId, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: { id: 'voice-request', approved: true },
        }));
    });
});
