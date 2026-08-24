import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { AgentInputLocalUiStateV1 } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
const activeScopeState = vi.hoisted(() => ({
    value: { serverId: 'server-a', accountId: 'account-a' } as ServerAccountScope,
}));
const appStateListeners = vi.hoisted(() => new Set<(nextState: string) => void>());

function installMockDocument(visibilityState: 'hidden' | 'visible' = 'visible') {
    const listeners = new Set<() => void>();
    let currentVisibilityState = visibilityState;
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            get visibilityState() {
                return currentVisibilityState;
            },
            addEventListener: (eventName: string, listener: () => void) => {
                if (eventName === 'visibilitychange') {
                    listeners.add(listener);
                }
            },
            removeEventListener: (eventName: string, listener: () => void) => {
                if (eventName === 'visibilitychange') {
                    listeners.delete(listener);
                }
            },
        },
    });

    return {
        setVisibilityState: (nextVisibilityState: 'hidden' | 'visible') => {
            currentVisibilityState = nextVisibilityState;
        },
        emitVisibilityChange: () => {
            listeners.forEach((listener) => listener());
        },
        restore: () => {
            if (previousDescriptor) {
                Object.defineProperty(globalThis, 'document', previousDescriptor);
            } else {
                delete (globalThis as { document?: unknown }).document;
            }
        },
    };
}

function installMockWindowLifecycleEvents() {
    const listenersByEvent = new Map<string, Set<() => void>>();
    const previousAddEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
    const previousRemoveEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');

    Object.defineProperty(globalThis, 'addEventListener', {
        configurable: true,
        value: (eventName: string, listener: () => void) => {
            const listeners = listenersByEvent.get(eventName) ?? new Set<() => void>();
            listeners.add(listener);
            listenersByEvent.set(eventName, listeners);
        },
    });
    Object.defineProperty(globalThis, 'removeEventListener', {
        configurable: true,
        value: (eventName: string, listener: () => void) => {
            listenersByEvent.get(eventName)?.delete(listener);
        },
    });

    return {
        emit: (eventName: string) => {
            listenersByEvent.get(eventName)?.forEach((listener) => listener());
        },
        restore: () => {
            if (previousAddEventListenerDescriptor) {
                Object.defineProperty(globalThis, 'addEventListener', previousAddEventListenerDescriptor);
            } else {
                delete (globalThis as { addEventListener?: unknown }).addEventListener;
            }
            if (previousRemoveEventListenerDescriptor) {
                Object.defineProperty(globalThis, 'removeEventListener', previousRemoveEventListenerDescriptor);
            } else {
                delete (globalThis as { removeEventListener?: unknown }).removeEventListener;
            }
        },
    };
}

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }

        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }

        delete(key: string) {
            mmkvStore.delete(key);
        }

        getAllKeys() {
            return [...mmkvStore.keys()];
        }

        clearAll() {
            mmkvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        AppState: {
            currentState: 'active',
            addEventListener: (_eventName: string, listener: (nextState: string) => void) => {
                appStateListeners.add(listener);
                return {
                    remove: () => {
                        appStateListeners.delete(listener);
                    },
                };
            },
        },
    });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useActiveServerAccountScope: () => activeScopeState.value,
    });
});

async function importHook() {
    return await import('./useSessionAgentInputComposerPersistence');
}

async function importLocalUiStateStore() {
    return await import('@/sync/domains/input/draftValues/agentInputLocalUiStateStore');
}

async function importExistingSessionDraftSemanticValues() {
    return await import('@/sync/domains/input/drafts/existingSessionDraftSemanticValues');
}

async function importSessionDraftRepository() {
    return await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
}

async function importLocalUiStatePersistence() {
    return await import('@/sync/domains/state/agentInputLocalUiStatePersistence');
}

async function importSessionDraftValuesPersistence() {
    return await import('@/sync/domains/state/sessionDraftValuesPersistence');
}

describe('useSessionAgentInputComposerPersistence', () => {
    beforeEach(() => {
        mmkvStore.clear();
        appStateListeners.clear();
        activeScopeState.value = { serverId: 'server-a', accountId: 'account-a' };
        vi.resetModules();
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('persists expansion per session owner and restores it after session switches', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();

        const hook = await renderHook(
            (sessionId: string) => useSessionAgentInputComposerPersistence({ sessionId }),
            { initialProps: 'session-a' },
        );

        expect(hook.getCurrent().expanded).toBe(false);

        await act(async () => {
            hook.getCurrent().setExpanded(true);
        });

        expect(hook.getCurrent().expanded).toBe(true);
        expect(localUiStateStore.readAgentInputLocalUiState(activeScopeState.value, {
            kind: 'session',
            sessionId: 'session-a',
        })?.expanded).toBe(true);

        await hook.rerender('session-b');

        expect(hook.getCurrent().expanded).toBe(false);

        await hook.rerender('session-a');

        expect(hook.getCurrent().expanded).toBe(true);
    });

    it('does not expose the previous owner expansion or scroll state during the first render after a session switch', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const scope = activeScopeState.value;
        const ownerA = { kind: 'session' as const, sessionId: 'session-a' };
        const ownerB = { kind: 'session' as const, sessionId: 'session-b' };
        const renders: Array<Readonly<{
            sessionId: string;
            expanded: boolean;
            initialScrollY?: number;
        }>> = [];

        localUiStateStore.patchAgentInputLocalUiState(scope, ownerA, {
            expanded: true,
            scrollY: 12,
            textLength: 100,
            fontScale: 1,
        });
        localUiStateStore.patchAgentInputLocalUiState(scope, ownerB, {
            expanded: false,
            scrollY: 660,
            textLength: 489,
            fontScale: 1,
        });

        function Harness({ sessionId, textLength }: Readonly<{ sessionId: string; textLength: number }>) {
            const persistence = useSessionAgentInputComposerPersistence({
                sessionId,
                textLength,
                fontScale: 1,
            });
            renders.push({
                sessionId,
                expanded: persistence.expanded,
                initialScrollY: persistence.inputPersistence.initialScrollY,
            });
            return null;
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Harness, {
                sessionId: 'session-a',
                textLength: 100,
            }));
        });

        renders.length = 0;

        await act(async () => {
            tree.update(React.createElement(Harness, {
                sessionId: 'session-b',
                textLength: 489,
            }));
        });

        expect(renders[0]).toEqual({
            sessionId: 'session-b',
            expanded: false,
            initialScrollY: 660,
        });

        await act(async () => {
            tree.unmount();
        });
    });

    it('restores and persists scroll and selection per session owner', async () => {
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const owner = { kind: 'session' as const, sessionId: 'session-a' };

        localUiStateStore.patchAgentInputLocalUiState(activeScopeState.value, owner, {
            scrollY: 88,
            selection: { start: 4, end: 9 },
            textLength: 20,
            fontScale: 1,
        });

        const hook = await renderHook(
            (params: Readonly<{ sessionId: string; textLength: number }>) =>
                useSessionAgentInputComposerPersistence({
                    sessionId: params.sessionId,
                    textLength: params.textLength,
                    fontScale: 1,
                }),
            { initialProps: { sessionId: 'session-a', textLength: 20 } },
        );

        expect(hook.getCurrent().inputPersistence.initialScrollY).toBe(88);
        expect(hook.getCurrent().inputPersistence.initialSelection).toEqual({ start: 4, end: 9 });

        await act(async () => {
            hook.getCurrent().inputPersistence.onScrollYChange(42);
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 2, end: 5 }, 20);
            vi.advanceTimersByTime(150);
        });

        expect(localUiStateStore.readAgentInputLocalUiState(activeScopeState.value, owner, {
            textLength: 20,
            fontScale: 1,
        })).toEqual(expect.objectContaining({
            scrollY: 42,
            selection: { start: 2, end: 5 },
            textLength: 20,
            fontScale: 1,
        }));

        vi.useRealTimers();
    });

    it('flushes pending scroll and selection before adopting another session owner', async () => {
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const scope = activeScopeState.value;
        const owner = { kind: 'session' as const, sessionId: 'session-a' };

        const hook = await renderHook(
            (params: Readonly<{ sessionId: string; textLength: number }>) =>
                useSessionAgentInputComposerPersistence({
                    sessionId: params.sessionId,
                    textLength: params.textLength,
                    fontScale: 1,
                }),
            { initialProps: { sessionId: 'session-a', textLength: 20 } },
        );

        await act(async () => {
            hook.getCurrent().inputPersistence.onScrollYChange(64);
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 6, end: 6 }, 20);
        });

        await hook.rerender({ sessionId: 'session-b', textLength: 0 });
        localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);

        expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
            textLength: 20,
            fontScale: 1,
        })).toEqual(expect.objectContaining({
            scrollY: 64,
            selection: { start: 6, end: 6 },
            textLength: 20,
        }));

        vi.useRealTimers();
    });

    it('flushes pending local UI and structured input state when the app backgrounds', async () => {
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const localUiStatePersistence = await importLocalUiStatePersistence();
        const draftValuePersistence = await importSessionDraftValuesPersistence();
        const scope = activeScopeState.value;
        const owner = { kind: 'session' as const, sessionId: 'session-a' };
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        };

        const hook = await renderHook(
            () => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                text: 'Ask $review',
                textLength: 'Ask $review'.length,
                fontScale: 1,
            }),
        );

        await act(async () => {
            hook.getCurrent().inputPersistence.onScrollYChange(64);
            hook.getCurrent().structuredInputPersistence.onMentionsChange([mention]);
        });

        expect(localUiStatePersistence.loadPersistedAgentInputLocalUiState(scope)['session:session-a']).toBeUndefined();
        expect(draftValuePersistence.loadPersistedSessionDraftValues(scope)['session-a']).toBeUndefined();

        await act(async () => {
            appStateListeners.forEach((listener) => listener('background'));
        });

        localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);
        expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
            textLength: 'Ask $review'.length,
            fontScale: 1,
        })).toEqual(expect.objectContaining({
            scrollY: 64,
            textLength: 'Ask $review'.length,
        }));
        expect(existingSessionDraftSemanticValues.read(scope, 'session-a', 'structuredInput.mentions')).toEqual([mention]);

        vi.useRealTimers();
    });

    it('flushes pending local UI and structured input state when the web document is hidden', async () => {
        vi.useFakeTimers();
        const mockDocument = installMockDocument('visible');
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const localUiStatePersistence = await importLocalUiStatePersistence();
        const draftValuePersistence = await importSessionDraftValuesPersistence();
        const scope = activeScopeState.value;
        const owner = { kind: 'session' as const, sessionId: 'session-a' };
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        };

        try {
            const hook = await renderHook(
                () => useSessionAgentInputComposerPersistence({
                    sessionId: 'session-a',
                    text: 'Ask $review',
                    textLength: 'Ask $review'.length,
                    fontScale: 1,
                }),
            );

            await act(async () => {
                hook.getCurrent().inputPersistence.onScrollYChange(64);
                hook.getCurrent().structuredInputPersistence.onMentionsChange([mention]);
            });

            expect(localUiStatePersistence.loadPersistedAgentInputLocalUiState(scope)['session:session-a']).toBeUndefined();
            expect(draftValuePersistence.loadPersistedSessionDraftValues(scope)['session-a']).toBeUndefined();

            await act(async () => {
                mockDocument.setVisibilityState('hidden');
                mockDocument.emitVisibilityChange();
            });

            localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);
            expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
                textLength: 'Ask $review'.length,
                fontScale: 1,
            })).toEqual(expect.objectContaining({
                scrollY: 64,
                textLength: 'Ask $review'.length,
            }));
            expect(existingSessionDraftSemanticValues.read(scope, 'session-a', 'structuredInput.mentions')).toEqual([mention]);
        } finally {
            mockDocument.restore();
            vi.useRealTimers();
        }
    });

    it('flushes pending local UI and structured input state when the web window blurs while visible', async () => {
        vi.useFakeTimers();
        const mockDocument = installMockDocument('visible');
        const mockWindowLifecycle = installMockWindowLifecycleEvents();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const localUiStatePersistence = await importLocalUiStatePersistence();
        const draftValuePersistence = await importSessionDraftValuesPersistence();
        const scope = activeScopeState.value;
        const owner = { kind: 'session' as const, sessionId: 'session-a' };
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        };

        try {
            const hook = await renderHook(
                () => useSessionAgentInputComposerPersistence({
                    sessionId: 'session-a',
                    text: 'Ask $review',
                    textLength: 'Ask $review'.length,
                    fontScale: 1,
                }),
            );

            await act(async () => {
                hook.getCurrent().inputPersistence.onScrollYChange(64);
                hook.getCurrent().structuredInputPersistence.onMentionsChange([mention]);
            });

            expect(localUiStatePersistence.loadPersistedAgentInputLocalUiState(scope)['session:session-a']).toBeUndefined();
            expect(draftValuePersistence.loadPersistedSessionDraftValues(scope)['session-a']).toBeUndefined();

            mockDocument.setVisibilityState('visible');
            await act(async () => {
                mockWindowLifecycle.emit('blur');
            });

            localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);
            expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
                textLength: 'Ask $review'.length,
                fontScale: 1,
            })).toEqual(expect.objectContaining({
                scrollY: 64,
                textLength: 'Ask $review'.length,
            }));
            expect(existingSessionDraftSemanticValues.read(scope, 'session-a', 'structuredInput.mentions')).toEqual([mention]);
        } finally {
            mockWindowLifecycle.restore();
            mockDocument.restore();
            vi.useRealTimers();
        }
    });

    it('keeps restoreToken stable across self-originated selection and scroll persists', async () => {
        // Live incident (web composer, 2026-07-22): every keystroke persisted the
        // caret, which bumped the store's updatedAt, which churned restoreToken,
        // which made AgentInput's restore effect re-apply the (by then stale)
        // persisted selection — dragging the user's caret 20-100 characters
        // backwards while typing a long message. The token must identify a
        // restore generation, never echo our own persist writes.
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();

        const hook = await renderHook(
            () => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                textLength: 20,
                fontScale: 1,
            }),
        );

        const initialToken = hook.getCurrent().inputPersistence.restoreToken;

        await act(async () => {
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 5, end: 5 }, 21);
            vi.advanceTimersByTime(150);
        });
        expect(hook.getCurrent().inputPersistence.restoreToken).toBe(initialToken);

        await act(async () => {
            hook.getCurrent().inputPersistence.onScrollYChange(42);
            vi.advanceTimersByTime(150);
        });
        expect(hook.getCurrent().inputPersistence.restoreToken).toBe(initialToken);

        vi.useRealTimers();
    });

    it('changes restoreToken once when the persisted basis becomes applicable after an async draft load', async () => {
        // Regression (2026-07-23): opening a previous session mounts the
        // composer before the draft text is adopted (live textLength 0 vs
        // persisted textLength N), so the persisted scrollY is withheld by the
        // drift guard and the persisted selection is clamped to {0,0}. The
        // restore consumers are keyed on restoreToken — it must change exactly
        // once when the draft basis is adopted so the real scroll/selection get
        // applied, and then stay stable across self-originated persists.
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const owner = { kind: 'session' as const, sessionId: 'session-a' };

        localUiStateStore.patchAgentInputLocalUiState(activeScopeState.value, owner, {
            scrollY: 88,
            selection: { start: 30, end: 30 },
            textLength: 42,
            fontScale: 1,
        });

        const hook = await renderHook(
            (params: Readonly<{ textLength: number }>) =>
                useSessionAgentInputComposerPersistence({
                    sessionId: 'session-a',
                    textLength: params.textLength,
                    fontScale: 1,
                }),
            { initialProps: { textLength: 0 } },
        );

        const pendingToken = hook.getCurrent().inputPersistence.restoreToken;
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBeUndefined();

        await hook.rerender({ textLength: 42 });

        const adoptedToken = hook.getCurrent().inputPersistence.restoreToken;
        expect(adoptedToken).not.toBe(pendingToken);
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBe(88);
        expect(hook.getCurrent().inputPersistence.initialSelection).toEqual({ start: 30, end: 30 });

        await act(async () => {
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 31, end: 31 }, 43);
            vi.advanceTimersByTime(150);
        });
        expect(hook.getCurrent().inputPersistence.restoreToken).toBe(adoptedToken);

        vi.useRealTimers();
    });

    it('changes restoreToken when the session owner changes and after an explicit transient-state restore', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();

        const hook = await renderHook(
            (sessionId: string) => useSessionAgentInputComposerPersistence({
                sessionId,
                textLength: 20,
                fontScale: 1,
            }),
            { initialProps: 'session-a' },
        );

        const tokenA = hook.getCurrent().inputPersistence.restoreToken;

        await hook.rerender('session-b');
        const tokenB = hook.getCurrent().inputPersistence.restoreToken;
        expect(tokenB).not.toBe(tokenA);

        let captured: AgentInputLocalUiStateV1 | null = null;
        await act(async () => {
            hook.getCurrent().setExpanded(true);
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 3, end: 3 }, 20);
            captured = hook.getCurrent().captureTransientInputState();
        });
        const tokenBeforeRestore = hook.getCurrent().inputPersistence.restoreToken;

        await act(async () => {
            hook.getCurrent().restoreTransientInputState(captured);
        });
        expect(hook.getCurrent().inputPersistence.restoreToken).not.toBe(tokenBeforeRestore);
    });

    it('clears transient scroll and selection while preserving expansion after outbound handoff', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const owner = { kind: 'session' as const, sessionId: 'session-a' };

        localUiStateStore.patchAgentInputLocalUiState(activeScopeState.value, owner, {
            expanded: true,
            scrollY: 88,
            selection: { start: 4, end: 9 },
            textLength: 20,
            fontScale: 1,
        });

        const hook = await renderHook(
            () => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                textLength: 20,
                fontScale: 1,
            }),
        );

        expect(hook.getCurrent().expanded).toBe(true);
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBe(88);
        expect(hook.getCurrent().inputPersistence.initialSelection).toEqual({ start: 4, end: 9 });

        const current = hook.getCurrent() as ReturnType<typeof useSessionAgentInputComposerPersistence> & {
            clearTransientInputState?: () => void;
        };
        expect(current.clearTransientInputState).toBeTypeOf('function');

        await act(async () => {
            current.clearTransientInputState?.();
        });

        expect(hook.getCurrent().expanded).toBe(true);
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBeUndefined();
        expect(hook.getCurrent().inputPersistence.initialSelection).toBeUndefined();
        expect(localUiStateStore.readAgentInputLocalUiState(activeScopeState.value, owner, {
            textLength: 20,
            fontScale: 1,
        })).toEqual(expect.objectContaining({
            expanded: true,
        }));
        expect(localUiStateStore.readAgentInputLocalUiState(activeScopeState.value, owner, {
            textLength: 20,
            fontScale: 1,
        })?.scrollY).toBeUndefined();
    });

    it('hydrates structured mentions for surviving tokens and drops stale mentions', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const survivingMention = {
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        };
        const staleMention = {
            kind: 'skill' as const,
            tokenText: '$gone',
            name: 'gone',
        };
        existingSessionDraftSemanticValues.write(activeScopeState.value, 'session-a', 'structuredInput.mentions', [
            survivingMention,
            staleMention,
        ]);

        const hook = await renderHook(
            (text: string) => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                text,
                textLength: text.length,
                fontScale: 1,
            }),
            { initialProps: 'Ask $review' },
        );

        expect(hook.getCurrent().structuredInputPersistence.mentions).toEqual([survivingMention]);
        expect(existingSessionDraftSemanticValues.read(
            activeScopeState.value,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([survivingMention]);
    });

    it('does not rerender composer persistence for unrelated draft text writes', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const repository = await importSessionDraftRepository();
        let renderCount = 0;

        function Harness() {
            renderCount += 1;
            useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                text: '',
                textLength: 0,
                fontScale: 1,
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Harness));
        });
        const settledRenderCount = renderCount;

        await act(async () => {
            repository.writeExistingSessionDraft({
                scope: activeScopeState.value,
                sessionId: 'session-a',
                patch: { text: 'hello' },
            });
        });

        expect(renderCount).toBe(settledRenderCount);
        await act(async () => {
            tree!.unmount();
        });
    });

    it('persists structured mention changes for the session owner', async () => {
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        };

        const hook = await renderHook(
            () => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                text: 'Ask $review',
                textLength: 'Ask $review'.length,
                fontScale: 1,
            }),
        );

        await act(async () => {
            hook.getCurrent().structuredInputPersistence.onMentionsChange([mention]);
            vi.advanceTimersByTime(250);
        });

        expect(existingSessionDraftSemanticValues.read(
            activeScopeState.value,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([mention]);
        vi.useRealTimers();
    });

    it('does not drop a selected structured mention while the parent text prop is catching up', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            name: 'review',
        };

        const hook = await renderHook(
            (text: string) => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                text,
                textLength: text.length,
                fontScale: 1,
            }),
            { initialProps: 'Ask $' },
        );

        await act(async () => {
            hook.getCurrent().structuredInputPersistence.onMentionsChange([mention]);
        });

        expect(existingSessionDraftSemanticValues.read(
            activeScopeState.value,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([mention]);

        await hook.rerender('Ask $review');

        expect(hook.getCurrent().structuredInputPersistence.mentions).toEqual([mention]);
    });

    it('does not mutate the visible session input state when an old owner clear resolves after switching sessions', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const ownerA = { kind: 'session' as const, sessionId: 'session-a' };
        const ownerB = { kind: 'session' as const, sessionId: 'session-b' };

        localUiStateStore.patchAgentInputLocalUiState(activeScopeState.value, ownerA, {
            expanded: true,
            scrollY: 88,
            selection: { start: 4, end: 9 },
            textLength: 20,
            fontScale: 1,
        });
        localUiStateStore.patchAgentInputLocalUiState(activeScopeState.value, ownerB, {
            expanded: false,
            scrollY: 44,
            selection: { start: 1, end: 1 },
            textLength: 20,
            fontScale: 1,
        });

        const hook = await renderHook(
            (sessionId: string) => useSessionAgentInputComposerPersistence({
                sessionId,
                textLength: 20,
                fontScale: 1,
            }),
            { initialProps: 'session-a' },
        );

        const clearOwnerA = (hook.getCurrent() as ReturnType<typeof useSessionAgentInputComposerPersistence> & {
            clearTransientInputState?: () => void;
        }).clearTransientInputState;

        await hook.rerender('session-b');
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBe(44);

        await act(async () => {
            clearOwnerA?.();
        });

        expect(hook.getCurrent().expanded).toBe(false);
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBe(44);
        expect(hook.getCurrent().inputPersistence.initialSelection).toEqual({ start: 1, end: 1 });
        expect(localUiStateStore.readAgentInputLocalUiState(activeScopeState.value, ownerA, {
            textLength: 20,
            fontScale: 1,
        })?.scrollY).toBeUndefined();
    });

    it('isolates expansion by account scope', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } satisfies ServerAccountScope;
        const scopeB = { serverId: 'server-a', accountId: 'account-b' } satisfies ServerAccountScope;
        activeScopeState.value = scopeA;

        const hook = await renderHook(
            (sessionId: string) => useSessionAgentInputComposerPersistence({ sessionId }),
            { initialProps: 'session-a' },
        );

        await act(async () => {
            hook.getCurrent().setExpanded(true);
        });

        activeScopeState.value = scopeB;
        await hook.rerender('session-a');

        expect(hook.getCurrent().expanded).toBe(false);

        activeScopeState.value = scopeA;
        await hook.rerender('session-a');

        expect(hook.getCurrent().expanded).toBe(true);
    });

    it('garbage collects stale local UI state without deleting canonical semantic drafts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const scope = activeScopeState.value;
        const now = Date.now();
        const staleUiTime = now - 8 * 24 * 60 * 60 * 1000;

        localUiStateStore.patchAgentInputLocalUiState(scope, {
            kind: 'session',
            sessionId: 'stale-ui-session',
        }, {
            expanded: true,
            scrollY: 20,
            textLength: 100,
            fontScale: 1,
        }, { now: staleUiTime });
        existingSessionDraftSemanticValues.write(
            scope,
            'stale-draft-session',
            'routing.executionRunDelivery',
            'interrupt',
        );

        await renderHook(() => useSessionAgentInputComposerPersistence({
            sessionId: 'active-session',
            textLength: 0,
            fontScale: 1,
        }));

        expect(localUiStateStore.readAgentInputLocalUiState(scope, {
            kind: 'session',
            sessionId: 'stale-ui-session',
        })).toBeNull();
        expect(existingSessionDraftSemanticValues.read(
            scope,
            'stale-draft-session',
            'routing.executionRunDelivery',
        )).toBe('interrupt');

        localUiStateStore.patchAgentInputLocalUiState(scope, {
            kind: 'session',
            sessionId: 'foreground-stale-ui-session',
        }, {
            expanded: true,
            scrollY: 20,
            textLength: 100,
            fontScale: 1,
        }, { now: staleUiTime });
        existingSessionDraftSemanticValues.write(
            scope,
            'foreground-stale-draft-session',
            'routing.executionRunDelivery',
            'interrupt',
        );

        vi.advanceTimersByTime(60 * 60 * 1000 + 1);
        await act(async () => {
            appStateListeners.forEach((listener) => listener('active'));
        });

        expect(localUiStateStore.readAgentInputLocalUiState(scope, {
            kind: 'session',
            sessionId: 'foreground-stale-ui-session',
        })).toBeNull();
        expect(existingSessionDraftSemanticValues.read(
            scope,
            'foreground-stale-draft-session',
            'routing.executionRunDelivery',
        )).toBe('interrupt');

        vi.useRealTimers();
    });

    it('garbage collects stale local UI state on web visibility without deleting canonical semantic drafts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
        const mockDocument = installMockDocument('hidden');
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const { existingSessionDraftSemanticValues } = await importExistingSessionDraftSemanticValues();
        const scope = activeScopeState.value;
        const now = Date.now();
        const staleUiTime = now - 8 * 24 * 60 * 60 * 1000;

        try {
            await renderHook(() => useSessionAgentInputComposerPersistence({
                sessionId: 'active-session',
                textLength: 0,
                fontScale: 1,
            }));

            localUiStateStore.patchAgentInputLocalUiState(scope, {
                kind: 'session',
                sessionId: 'visible-stale-ui-session',
            }, {
                expanded: true,
                scrollY: 20,
                textLength: 100,
                fontScale: 1,
            }, { now: staleUiTime });
            existingSessionDraftSemanticValues.write(
                scope,
                'visible-stale-draft-session',
                'routing.executionRunDelivery',
                'interrupt',
            );

            vi.advanceTimersByTime(60 * 60 * 1000 + 1);
            await act(async () => {
                mockDocument.setVisibilityState('visible');
                mockDocument.emitVisibilityChange();
            });

            expect(localUiStateStore.readAgentInputLocalUiState(scope, {
                kind: 'session',
                sessionId: 'visible-stale-ui-session',
            })).toBeNull();
            expect(existingSessionDraftSemanticValues.read(
                scope,
                'visible-stale-draft-session',
                'routing.executionRunDelivery',
            )).toBe('interrupt');
        } finally {
            mockDocument.restore();
            vi.useRealTimers();
        }
    });
});
