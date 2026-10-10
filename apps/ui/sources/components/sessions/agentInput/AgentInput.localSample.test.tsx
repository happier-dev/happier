import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderHook, renderScreen } from '@/dev/testkit';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { storage } from '@/sync/domains/state/storageStore';
import { useDemoMessages } from '@/hooks/session/useDemoMessages';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

// Native, font/theme and icon adapters are the platform boundaries; composer,
// pending-request projection, prompt cards and permission answers remain real.
installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-crypto', async () => ({
    ...await import('@/platform/cryptoRandom.node'),
    ...await import('@/platform/randomUUID.node'),
}));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

beforeAll(async () => { await import('./AgentInput'); }, 600_000);

describe('AgentInput local sample conversation', () => {
    it('shows and answers the source pending request without inventing a live Session', async () => {
        const { AgentInput } = await import('./AgentInput');
        const respondToPermission = vi.fn(async () => undefined);
        const messages = [createToolCallMessageFixture({
                id: 'sample-tool',
                tool: {
                    name: 'Bash', state: 'running', input: { command: 'leads update-stage acme qualified' },
                    createdAt: 1, startedAt: null, completedAt: null, description: null,
                    permission: { id: 'sample-permission', status: 'pending' },
                },
            })];
        const options = {
            // A sample's declared Agent is presentation data, not a live Session.
            metadata: { path: '', host: '', flavor: 'claude' },
            interaction: { canSendMessages: true, canApprovePermissions: true },
            actions: {
                respondToPermission,
                answerUserAction: async () => undefined,
                submitMessage: async () => undefined,
                abort: async () => undefined,
            },
        };
        const dataset = await renderHook((rows: typeof messages) => useDemoMessages(rows, options), { initialProps: messages });
        const source = dataset.getCurrent();
        function SampleComposer() {
            const pending = source.usePendingRequests();
            const interaction = source.useInteraction();
            const metadata = source.useMetadata();
            return <AgentInput value="A follow-up" onChangeText={() => undefined} onSend={() => undefined}
                autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                permissionRequests={pending.permissionRequests} canApprovePermissions={interaction.canApprovePermissions}
                metadata={metadata ?? undefined}
                voiceAffordance="none" engineControls="none" />;
        }
        const before = storage.getState().sessions;
        const screen = await renderScreen(<SessionTranscriptSourceProvider source={source}><SampleComposer /></SessionTranscriptSourceProvider>);
        const allow = screen.findHostByTestId('permission-footer.allow');
        expect(allow).not.toBeNull();
        const send = screen.findByTestId('session-composer-send');
        expect(send).not.toBeNull();
        expect(send?.props.accessibilityLabel ?? send?.props['aria-label']).toBe('common.send');
        expect(screen.findHostByTestId('new-session-composer-send')).toBeNull();
        // Folding/replacing sample rows keeps the same source and Agent declaration.
        await dataset.rerender([...messages]);
        expect(dataset.getCurrent()).toBe(source);
        const updatedAllow = screen.findHostByTestId('permission-footer.allow');
        expect(updatedAllow).not.toBeNull();
        await pressTestInstanceAsync(updatedAllow!, 'local sample allow');
        expect(respondToPermission).toHaveBeenCalledWith(expect.objectContaining({ id: 'sample-permission', approved: true }));
        expect(storage.getState().sessions).toBe(before);
        await dataset.unmount();
    });

    it.each(['absent', 'readOnly'] as const)('keeps new-session context with %s non-interactive source', async (kind) => {
        const { AgentInput } = await import('./AgentInput');
        const input = <AgentInput value="A new chat" onChangeText={() => undefined} onSend={() => undefined}
            autocompleteKinds={[]} autocompleteSuggestions={async () => []} voiceAffordance="none" engineControls="none" />;
        const source = createReadOnlySessionTranscriptSource({
            sessionId: 'read-only-dataset', messages: [], reducerState: null, metadata: null, agentState: null,
        });
        const screen = await renderScreen(kind === 'absent' ? input : <SessionTranscriptSourceProvider source={source}>{input}</SessionTranscriptSourceProvider>);
        const send = screen.findByTestId('new-session-composer-send');
        expect(send).not.toBeNull();
        expect(send?.props.accessibilityLabel ?? send?.props['aria-label']).toBe('newSession.title');
        expect(screen.findHostByTestId('session-composer-send')).toBeNull();
        expect(screen.findHostByTestId('permission-footer.allow')).toBeNull();
    });
});
