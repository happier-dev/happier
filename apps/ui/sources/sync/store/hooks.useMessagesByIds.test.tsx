import React from 'react';
import { afterEach } from 'vitest';
import { describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useMessagesByIds } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

describe('useMessagesByIds', () => {
    it('returns a referentially stable array when store state is unchanged', async () => {
        const previousState = storage.getState();
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2'],
                        messagesById,
                        messagesMap: messagesById,
                        draftsByLocalId: {},
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const ids = ['m-1', 'm-2'] as const;
            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            const first = hook.getCurrent();
            const second = await hook.rerender();
            expect(second).toBe(first);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not trigger React 18 external-store snapshot warnings (getSnapshot should be cached)', async () => {
        const previousState = storage.getState();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const messagesById = {
                'm-1': { id: 'm-1', kind: 'user-text', localId: null, createdAt: 1, text: 'hi' } as any,
                'm-2': { id: 'm-2', kind: 'agent-text', localId: null, createdAt: 2, text: 'hello', isThinking: false } as any,
            };

            storage.setState((state) => ({
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    's-1': {
                        messageIdsOldestFirst: ['m-1', 'm-2'],
                        messagesById,
                        messagesMap: messagesById,
                        draftsByLocalId: {},
                        reducerState: {} as any,
                        latestThinkingMessageId: null,
                        latestThinkingMessageActivityAtMs: null,
                        messagesVersion: 1,
                        isLoaded: true,
                    },
                },
            }));

            const ids = ['m-1', 'm-2'] as const;
            function StrictModeWrapper({ children }: React.PropsWithChildren) {
                return <React.StrictMode>{children}</React.StrictMode>;
            }

            const hook = await renderHook(() => useMessagesByIds('s-1', ids), {
                wrapper: StrictModeWrapper,
                flushOptions: { cycles: 1, turns: 4 },
            });

            const allMessages = spy.mock.calls.map((c) => String(c[0] ?? ''));
            expect(allMessages.some((m) => m.includes('getSnapshot') && m.includes('cached'))).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
            spy.mockRestore();
        }
    });
});
