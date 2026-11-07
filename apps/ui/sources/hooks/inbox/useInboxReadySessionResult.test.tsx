import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Native Markdown is a third-party boundary; this data reader renders no Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { storage } from '@/sync/domains/state/storageStore';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import { useInboxReadySessionResult } from './useInboxReadySessionResult';
import { isSessionListRowVisible, resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';

afterEach(async () => { await standardCleanup(); resetSessionSurfaceVisibilityForTests(); });

describe('useInboxReadySessionResult', () => {
    it('keeps an absent candidate unavailable without acquiring content', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        try {
            const hook = await renderHook(() => useInboxReadySessionResult(null));
            const result = hook.getCurrent();
            expect(result).toEqual({ preview: { state: 'unavailable' }, workflowInvocation: null, completedAt: null });
            await hook.rerender();
            expect(hook.getCurrent()).toBe(result);
            expect(fetch).not.toHaveBeenCalled();
            await hook.unmount();
        } finally { fetch.mockRestore(); }
    });

    it('does no reads, writes or unrelated token renders and releases visible demand when hidden', async () => {
        const before = storage.getState();
        const fetch = vi.spyOn(globalThis, 'fetch');
        const session = createSessionFixture({ id: 'bot', serverId: 'home', encryptionMode: 'e2ee', encryptedContentAvailability: 'ready',
            latestTurnId: 'done', latestTurnStatus: 'completed', sessionTurns: { v: 1, sessionId: 'bot', updatedAt: 5,
                turns: [{ turnId: 'done', startedAt: 1, updatedAt: 5, status: 'completed',
                    transcriptAnchors: { finalAssistantMessageSeq: 4 } }] } });
        const message: Message = { kind: 'agent-text', id: 'result', seq: 4, createdAt: 4, localId: null, text: 'Private result' };
        const other: Message = { ...message, id: 'other', seq: 8, text: 'Unrelated token' };
        storage.setState({ profileScope: { serverId: 'home', accountId: 'plain-account' }, sessions: { bot: session },
            sessionListRowsByServerId: { home: { bot: buildSessionListRenderableFromSession(session) } },
            sessionMessages: { bot: { messageIdsOldestFirst: ['result', 'other'], messagesById: { result: message, other },
                messagesMap: { result: message, other }, reducerState: createReducer(), latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null, messagesVersion: 1, isLoaded: true } } });
        try {
            const metadata = session.metadata;
            const candidate = buildSessionActivityAttention({ session, nowMs: 10 });
            let renders = 0;
            const hook = await renderHook(({ active }: { active: boolean }) => {
                renders += 1;
                return useInboxReadySessionResult(candidate, { active });
            }, { initialProps: { active: true } });
            expect(hook.getCurrent().preview).toEqual({ state: 'available', text: 'Private result' });
            const mounted = renders;
            await act(async () => {
                const transcript = storage.getState().sessionMessages.bot!;
                storage.setState({ sessionMessages: { bot: { ...transcript, messagesVersion: 2,
                    messagesById: { ...transcript.messagesById, other: { ...other, text: 'More unrelated tokens' } } } } });
            });
            expect(renders).toBe(mounted);
            await act(async () => {
                const transcript = storage.getState().sessionMessages.bot!;
                storage.setState({ sessionMessages: { bot: { ...transcript, messagesVersion: 3,
                    messagesById: { ...transcript.messagesById, result: { ...message, text: 'Updated result' } } } } });
            });
            expect(hook.getCurrent().preview).toEqual({ state: 'available', text: 'Updated result' });
            await act(async () => {
                storage.setState({ sessions: { bot: { ...session, sessionTurns: { ...session.sessionTurns!,
                    turns: [{ ...session.sessionTurns!.turns[0]!, transcriptAnchors: { finalAssistantMessageSeq: 8 } }] } } } });
            });
            expect(hook.getCurrent().preview).toEqual({ state: 'available', text: 'More unrelated tokens' });
            expect(isSessionListRowVisible('bot', 'home')).toBe(true);
            await hook.rerender({ active: false });
            expect(isSessionListRowVisible('bot', 'home')).toBe(false);
            expect(hook.getCurrent().preview.state).toBe('unavailable');
            expect(storage.getState().sessions.bot?.metadata).toBe(metadata);
            expect(fetch).not.toHaveBeenCalled();
            await hook.unmount();
        } finally { fetch.mockRestore(); storage.setState(before); }
    });
});
