import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { AgentInputLocalUiStateV1 } from '@/sync/domains/input/draftValues/agentInputLocalUiStateStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const mmkvStore = vi.hoisted(() => new Map<string, string>());
const activeScopeState: { value: ServerAccountScope | null } = { value: null };
const appStateListeners = vi.hoisted(() => new Set<(nextState: string) => void>());
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let captureLifetime: typeof import('@/sync/domains/scope/activeServerAccountScope').captureActiveServerAccountScopeLifetime;

installDisconnectedServerSocketBoundary();

async function activateAccount(accountId: string) {
    await account?.dispose();
    account = await restoreServerAccountForTest({
        serverUrl: 'https://composer-drafts.test',
        accountId,
        request: async (url) => {
            const path = new URL(String(url)).pathname;
            const json = (value: unknown) => new Response(JSON.stringify(value));
            if (path === '/v1/features' || path === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
            return new Response('{}', { status: 404 });
        },
    });
    activeScopeState.value = captureLifetime()?.scope ?? null;
    expect(activeScopeState.value?.accountId).toBe(accountId);
}

function getActiveAccountLifetime() {
    return captureLifetime();
}

function installMockDocument(visibilityState: 'hidden' | 'visible' = 'visible') {
    const previousDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const visibilityListeners = new Set<() => void>();
    let currentVisibilityState = visibilityState;

    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            get visibilityState() {
                return currentVisibilityState;
            },
            addEventListener: (eventName: string, listener: () => void) => {
                if (eventName === 'visibilitychange') {
                    visibilityListeners.add(listener);
                }
            },
            removeEventListener: (eventName: string, listener: () => void) => {
                if (eventName === 'visibilitychange') {
                    visibilityListeners.delete(listener);
                }
            },
        },
    });

    return {
        setVisibilityState: (nextVisibilityState: 'hidden' | 'visible') => {
            currentVisibilityState = nextVisibilityState;
        },
        fireVisibilityChange: () => {
            visibilityListeners.forEach((listener) => listener());
        },
        restore: () => {
            if (previousDocumentDescriptor) {
                Object.defineProperty(globalThis, 'document', previousDocumentDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'document');
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
                Reflect.deleteProperty(globalThis, 'addEventListener');
            }
            if (previousRemoveEventListenerDescriptor) {
                Object.defineProperty(globalThis, 'removeEventListener', previousRemoveEventListenerDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'removeEventListener');
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

vi.mock('@react-navigation/native', async () => (
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock()
));

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

async function importHook() {
    const module = await import('./useSessionAgentInputComposerPersistence');
    const { createComposerTextStore } = await import('@/components/sessions/agentInput/composerTextStore');
    return {
        ...module,
        // Cases describe the composer's text as a controlled value (or only its length); each
        // value becomes the live text store the composer would hold at that render.
        useSessionAgentInputComposerPersistence: (
            params: Omit<Parameters<typeof module.useSessionAgentInputComposerPersistence>[0], 'textStore'> & Readonly<{
                text?: string;
                textLength?: number;
            }>,
        ) => {
            const { text, textLength, ...rest } = params;
            const liveText = text ?? (textLength === undefined ? undefined : 'x'.repeat(textLength));
            const textStore = React.useMemo(
                () => (liveText === undefined ? undefined : createComposerTextStore(liveText)),
                [liveText],
            );
            return module.useSessionAgentInputComposerPersistence({
                ...rest,
                textStore,
                accountLifetime: rest.accountLifetime ?? getActiveAccountLifetime(),
            });
        },
    };
}

async function importLocalUiStateStore() {
    return await import('@/sync/domains/input/draftValues/agentInputLocalUiStateStore');
}

async function importSessionDraftValueStore() {
    return await import('@/dev/testkit/sessionDraftRepositoryTestkit');
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
    beforeEach(async () => {
        mmkvStore.clear();
        appStateListeners.clear();
        vi.resetModules();
        // IndexedDB is the browser boundary; exercise the real repository and migration owner.
        vi.stubGlobal('indexedDB', new IDBFactory());
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        await loadSyncSingletonForTests();
        ({ captureActiveServerAccountScopeLifetime: captureLifetime } = await import('@/sync/domains/scope/activeServerAccountScope'));
        await activateAccount('account-a');
    });

    afterEach(async () => {
        vi.useRealTimers();
        await standardCleanup();
        await account?.dispose();
        account = undefined;
        vi.unstubAllGlobals();
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
            expanded: boolean;
            initialScrollY?: number;
            sessionId: string;
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
                expanded: persistence.expanded,
                initialScrollY: persistence.inputPersistence.initialScrollY,
                sessionId,
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
            expanded: false,
            initialScrollY: 660,
            sessionId: 'session-b',
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
    });

    it('flushes pending local UI and structured input state when the app backgrounds', async () => {
        vi.useFakeTimers();
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const localUiStateStore = await importLocalUiStateStore();
        const draftValueStore = await importSessionDraftValueStore();
        const localUiStatePersistence = await importLocalUiStatePersistence();
        const draftValuePersistence = await importSessionDraftValuesPersistence();
        const scope = activeScopeState.value;
        const owner = { kind: 'session' as const, sessionId: 'session-a' };
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            start: 4,
            end: 11,
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

        expect(localUiStatePersistence.loadRawAgentInputLocalUiState(scope)['session:session-a']).toBeUndefined();
        expect(draftValuePersistence.loadRawSessionDraftValues(scope)['session-a']).toBeUndefined();

        await act(async () => {
            appStateListeners.forEach((listener) => listener('background'));
        });

        localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);
        draftValueStore.invalidateSessionDraftValueCache(scope);
        expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
            textLength: 'Ask $review'.length,
            fontScale: 1,
        })).toEqual(expect.objectContaining({
            scrollY: 64,
            textLength: 'Ask $review'.length,
        }));
        expect(draftValueStore.readSessionDraftValue(scope, 'session-a', 'structuredInput.mentions')).toEqual([mention]);
    });

    it('flushes pending local UI and structured input state when the web document is hidden', async () => {
        vi.useFakeTimers();
        const mockDocument = installMockDocument('visible');
        try {
            const { useSessionAgentInputComposerPersistence } = await importHook();
            const localUiStateStore = await importLocalUiStateStore();
            const draftValueStore = await importSessionDraftValueStore();
            const localUiStatePersistence = await importLocalUiStatePersistence();
            const draftValuePersistence = await importSessionDraftValuesPersistence();
            const scope = activeScopeState.value;
            const owner = { kind: 'session' as const, sessionId: 'session-a' };
            const mention = {
                kind: 'skill' as const,
                tokenText: '$review',
                start: 4,
                end: 11,
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

            expect(localUiStatePersistence.loadRawAgentInputLocalUiState(scope)['session:session-a']).toBeUndefined();
            expect(draftValuePersistence.loadRawSessionDraftValues(scope)['session-a']).toBeUndefined();

            await act(async () => {
                mockDocument.setVisibilityState('hidden');
                mockDocument.fireVisibilityChange();
            });

            localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);
            draftValueStore.invalidateSessionDraftValueCache(scope);
            expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
                textLength: 'Ask $review'.length,
                fontScale: 1,
            })).toEqual(expect.objectContaining({
                scrollY: 64,
                textLength: 'Ask $review'.length,
            }));
            expect(draftValueStore.readSessionDraftValue(scope, 'session-a', 'structuredInput.mentions')).toEqual([mention]);
        } finally {
            mockDocument.restore();
        }
    });

    it('flushes pending local UI and structured input state when the web window blurs while visible', async () => {
        vi.useFakeTimers();
        const mockDocument = installMockDocument('visible');
        const mockWindowLifecycle = installMockWindowLifecycleEvents();
        try {
            const { useSessionAgentInputComposerPersistence } = await importHook();
            const localUiStateStore = await importLocalUiStateStore();
            const draftValueStore = await importSessionDraftValueStore();
            const localUiStatePersistence = await importLocalUiStatePersistence();
            const draftValuePersistence = await importSessionDraftValuesPersistence();
            const scope = activeScopeState.value;
            const owner = { kind: 'session' as const, sessionId: 'session-a' };
            const mention = {
                kind: 'skill' as const,
                tokenText: '$review',
                start: 4,
                end: 11,
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

            expect(localUiStatePersistence.loadRawAgentInputLocalUiState(scope)['session:session-a']).toBeUndefined();
            expect(draftValuePersistence.loadRawSessionDraftValues(scope)['session-a']).toBeUndefined();

            mockDocument.setVisibilityState('visible');
            await act(async () => {
                mockWindowLifecycle.emit('blur');
            });

            localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);
            draftValueStore.invalidateSessionDraftValueCache(scope);
            expect(localUiStateStore.readAgentInputLocalUiState(scope, owner, {
                textLength: 'Ask $review'.length,
                fontScale: 1,
            })).toEqual(expect.objectContaining({
                scrollY: 64,
                textLength: 'Ask $review'.length,
            }));
            expect(draftValueStore.readSessionDraftValue(scope, 'session-a', 'structuredInput.mentions')).toEqual([mention]);
        } finally {
            mockWindowLifecycle.restore();
            mockDocument.restore();
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

        await act(async () => {
            hook.getCurrent().clearTransientInputState();
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

    it('captures and restores transient input state for failed outbound handoff recovery', async () => {
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

        expect(typeof hook.getCurrent().captureTransientInputState).toBe('function');
        expect(typeof hook.getCurrent().restoreTransientInputState).toBe('function');
        const snapshot = hook.getCurrent().captureTransientInputState?.();

        await act(async () => {
            hook.getCurrent().clearTransientInputState();
        });

        expect(hook.getCurrent().inputPersistence.initialScrollY).toBeUndefined();

        await act(async () => {
            hook.getCurrent().restoreTransientInputState?.(snapshot ?? null);
        });

        expect(hook.getCurrent().expanded).toBe(true);
        expect(hook.getCurrent().inputPersistence.initialScrollY).toBe(88);
        expect(hook.getCurrent().inputPersistence.initialSelection).toEqual({ start: 4, end: 9 });
        expect(localUiStateStore.readAgentInputLocalUiState(activeScopeState.value, owner, {
            textLength: 20,
            fontScale: 1,
        })).toEqual(expect.objectContaining({
            expanded: true,
            scrollY: 88,
            selection: { start: 4, end: 9 },
        }));
    });

    it('hydrates only surviving structured mentions without mutating the synchronized draft during render', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const draftValueStore = await importSessionDraftValueStore();
        const survivingMention = {
            kind: 'skill' as const,
            tokenText: '$review',
            start: 4,
            end: 11,
            name: 'review',
        };
        const staleMention = {
            kind: 'skill' as const,
            tokenText: '$gone',
            start: 4,
            end: 9,
            name: 'gone',
        };
        draftValueStore.writeSessionDraftValue(activeScopeState.value, 'session-a', 'structuredInput.mentions', [
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
        expect(draftValueStore.readSessionDraftValue(
            activeScopeState.value,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([survivingMention, staleMention]);
    });

    it('does not rerender composer persistence for unrelated draft text writes', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const repository = await importSessionDraftRepository();
        const scope = activeScopeState.value;
        if (!scope) throw new Error('expected active account scope');
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
                scope,
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
        const draftValueStore = await importSessionDraftValueStore();
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            start: 4,
            end: 11,
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

        expect(draftValueStore.readSessionDraftValue(
            activeScopeState.value,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([mention]);
    });

    it('does not drop a selected structured mention while the parent text prop is catching up', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const draftValueStore = await importSessionDraftValueStore();
        const mention = {
            kind: 'skill' as const,
            tokenText: '$review',
            start: 4,
            end: 11,
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

        expect(draftValueStore.readSessionDraftValue(
            activeScopeState.value,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([mention]);

        await hook.rerender('Ask $review');

        expect(hook.getCurrent().structuredInputPersistence.mentions).toEqual([mention]);
    });

    it('isolates expansion by account scope', async () => {
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const hook = await renderHook(
            (sessionId: string) => useSessionAgentInputComposerPersistence({ sessionId }),
            { initialProps: 'session-a' },
        );

        await act(async () => {
            hook.getCurrent().setExpanded(true);
        });

        await act(async () => { await activateAccount('account-b'); });
        await hook.rerender('session-a');

        expect(hook.getCurrent().expanded).toBe(false);

        await act(async () => { await activateAccount('account-a'); });
        await hook.rerender('session-a');

        expect(hook.getCurrent().expanded).toBe(true);
    });

    it('garbage collects stale local UI state without deleting synchronized draft state when the hook mounts', async () => {
        vi.useFakeTimers();
        const now = Date.UTC(2026, 4, 27);
        vi.setSystemTime(now);
        const { useSessionAgentInputComposerPersistence } = await importHook();
        const draftValueStore = await importSessionDraftValueStore();
        const localUiStateStore = await importLocalUiStateStore();
        const staleMention = {
            kind: 'skill' as const,
            tokenText: '$review',
            start: 4,
            end: 11,
            name: 'review',
        };
        const scope = activeScopeState.value;

        draftValueStore.writeSessionDraftValue(
            scope,
            'session-a',
            'structuredInput.mentions',
            [staleMention],
            now - 31 * 24 * 60 * 60 * 1000,
        );
        draftValueStore.flushSessionDraftValues(scope);
        localUiStateStore.patchAgentInputLocalUiState(
            scope,
            { kind: 'session', sessionId: 'session-a' },
            {
                expanded: true,
                scrollY: 32,
                selection: { start: 2, end: 2 },
                textLength: 11,
                fontScale: 1,
            },
            now - 8 * 24 * 60 * 60 * 1000,
        );
        localUiStateStore.flushAgentInputLocalUiState(scope);

        await renderHook(
            () => useSessionAgentInputComposerPersistence({
                sessionId: 'session-a',
                text: 'Ask $review',
                textLength: 'Ask $review'.length,
                fontScale: 1,
            }),
        );

        draftValueStore.invalidateSessionDraftValueCache(scope);
        localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);

        expect(draftValueStore.readSessionDraftValue(
            scope,
            'session-a',
            'structuredInput.mentions',
        )).toEqual([staleMention]);
        expect(localUiStateStore.readAgentInputLocalUiState(
            scope,
            { kind: 'session', sessionId: 'session-a' },
            {
                textLength: 'Ask $review'.length,
                fontScale: 1,
            },
        )).toBeNull();
    });

    it('garbage collects stale local UI state without deleting synchronized draft state when the web document becomes visible', async () => {
        vi.useFakeTimers();
        const now = Date.UTC(2026, 4, 27);
        vi.setSystemTime(now);
        const mockDocument = installMockDocument('hidden');

        try {
            const { useSessionAgentInputComposerPersistence } = await importHook();
            const draftValueStore = await importSessionDraftValueStore();
            const localUiStateStore = await importLocalUiStateStore();
            const staleMention = {
                kind: 'skill' as const,
                tokenText: '$review',
                start: 4,
                end: 11,
                name: 'review',
            };
            const scope = activeScopeState.value;

            await renderHook(
                () => useSessionAgentInputComposerPersistence({
                    sessionId: 'session-a',
                    text: 'Ask $review',
                    textLength: 'Ask $review'.length,
                    fontScale: 1,
                }),
            );

            draftValueStore.writeSessionDraftValue(
                scope,
                'session-a',
                'structuredInput.mentions',
                [staleMention],
                now - 31 * 24 * 60 * 60 * 1000,
            );
            draftValueStore.flushSessionDraftValues(scope);
            localUiStateStore.patchAgentInputLocalUiState(
                scope,
                { kind: 'session', sessionId: 'session-a' },
                {
                    expanded: true,
                    scrollY: 32,
                    selection: { start: 2, end: 2 },
                    textLength: 11,
                    fontScale: 1,
                },
                now - 8 * 24 * 60 * 60 * 1000,
            );
            localUiStateStore.flushAgentInputLocalUiState(scope);

            vi.advanceTimersByTime(60 * 60 * 1000 + 1);
            await act(async () => {
                mockDocument.setVisibilityState('visible');
                mockDocument.fireVisibilityChange();
            });

            draftValueStore.invalidateSessionDraftValueCache(scope);
            localUiStateStore.invalidateAgentInputLocalUiStateCache(scope);

            expect(draftValueStore.readSessionDraftValue(
                scope,
                'session-a',
                'structuredInput.mentions',
            )).toEqual([staleMention]);
            expect(localUiStateStore.readAgentInputLocalUiState(
                scope,
                { kind: 'session', sessionId: 'session-a' },
                {
                    textLength: 'Ask $review'.length,
                    fontScale: 1,
                },
            )).toBeNull();
        } finally {
            mockDocument.restore();
        }
    });
});
