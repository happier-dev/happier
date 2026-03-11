import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useSessionPaneUrlSync } from './useSessionPaneUrlSync';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: any) {
    useSessionPaneUrlSync(props);
    return null;
}

function clearSessionPaneTestStorage() {
    const storage = ensureSessionPaneTestStorage();
    storage.clear();
}

type SessionPaneWindowStub = {
    location: { href: string };
    history: {
        state: unknown;
        pushState: (state: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (state: unknown, unused: string, url?: string | URL | null) => void;
    };
    addEventListener?: (type: string, listener: (event: { type: string }) => void) => void;
    removeEventListener?: (type: string, listener: (event: { type: string }) => void) => void;
    dispatchEvent?: (event: { type: string }) => boolean;
};

function ensureSessionPaneTestStorage() {
    const target = globalThis as typeof globalThis & { sessionStorage?: Storage };
    if (target.sessionStorage) {
        return target.sessionStorage;
    }

    const values = new Map<string, string>();
    const storage = {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        getItem(key: string) {
            return values.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(values.keys())[index] ?? null;
        },
        removeItem(key: string) {
            values.delete(key);
        },
        setItem(key: string, value: string) {
            values.set(key, value);
        },
    } satisfies Storage;

    Object.defineProperty(target, 'sessionStorage', {
        configurable: true,
        value: storage,
    });

    return storage;
}

function ensurePaneUrlSyncWindow() {
    const target = globalThis as typeof globalThis & { window?: unknown };

    if (target.window && typeof target.window === 'object') {
        const candidate = target.window as unknown as Partial<SessionPaneWindowStub>;
        if (
            candidate.location
            && typeof candidate.location.href === 'string'
            && candidate.history
            && typeof candidate.history.pushState === 'function'
            && typeof candidate.history.replaceState === 'function'
        ) {
            return candidate as SessionPaneWindowStub;
        }
    }

    const listeners = new Map<string, Set<(event: { type: string }) => void>>();
    const windowStub: SessionPaneWindowStub = {
        location: { href: 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288' },
        history: {
            state: null,
            pushState: vi.fn(),
            replaceState: vi.fn((state: unknown) => {
                windowStub.history.state = state;
            }),
        },
        addEventListener(type: string, listener: (event: { type: string }) => void) {
            const existing = listeners.get(type) ?? new Set<(event: { type: string }) => void>();
            existing.add(listener);
            listeners.set(type, existing);
        },
        removeEventListener(type: string, listener: (event: { type: string }) => void) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event: { type: string }) {
            for (const listener of listeners.get(event.type) ?? []) {
                listener(event);
            }
            return true;
        },
    };

    Object.defineProperty(target, 'window', {
        configurable: true,
        value: windowStub,
    });

    return windowStub;
}

async function flushDeferredSessionPaneHistoryStateWrite() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('useSessionPaneUrlSync', () => {
    it('pushes a browser history entry for pane changes after the initial mount', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        const pushStateMock = vi.spyOn(windowStub.history, 'pushState');
        windowStub.location.href = 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288';

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const openBottomScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pushStateMock).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledTimes(0);

        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={openBottomScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pushStateMock).toHaveBeenCalledTimes(1);
        expect(pushStateMock).toHaveBeenCalledWith(
            null,
            '',
            'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288&bottom=terminal'
        );
        expect(setParams).toHaveBeenCalledWith({
            right: undefined,
            bottom: 'terminal',
            details: undefined,
            path: undefined,
            sha: undefined,
        });
    });

    it('does not push browser history for the first pane-url sync on mount', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        const pushStateMock = vi.spyOn(windowStub.history, 'pushState');
        windowStub.location.href = 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288';

        const openBottomScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        await act(async () => {
            renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={openBottomScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pushStateMock).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledWith({
            right: undefined,
            bottom: 'terminal',
            details: undefined,
            path: undefined,
            sha: undefined,
        });
    });

    it('restores the last stored pane state when a session remounts without pane url params', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        await act(async () => {
            tree.unmount();
        });

        pane.openBottom.mockClear();
        pane.setBottomTab.mockClear();

        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.setBottomTab).toHaveBeenCalledWith('terminal');
    });

    it('persists pane closures so a later remount does not reopen cleared pane state', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:close-me"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:close-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                    __updateToken="closed"
                />
            );
        });

        await act(async () => {
            tree.unmount();
        });

        pane.openBottom.mockClear();
        pane.setBottomTab.mockClear();

        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:close-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openBottom).toHaveBeenCalledTimes(0);
        expect(pane.setBottomTab).toHaveBeenCalledTimes(0);
    });

    it('does not restore stored pane state when the current history entry explicitly represents a pane-less url', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.location.href = 'http://localhost:19364/session/restore-me?server=http%3A%2F%2Flocalhost%3A53288';

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        await act(async () => {
            tree.unmount();
        });

        pane.openBottom.mockClear();
        pane.setBottomTab.mockClear();

        windowStub.history.state = {
            id: 'session-entry',
            happierSessionPane: {
                scopeKey: 'session:restore-me',
                urlSig: '||||',
            },
        };

        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openBottom).toHaveBeenCalledTimes(0);
        expect(pane.setBottomTab).toHaveBeenCalledTimes(0);
    });

    it('does not overwrite the stored clean-url pane preference while replaying url-driven pane state', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const storage = ensureSessionPaneTestStorage();
        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:history-preference"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history-preference"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                    __updateToken="closed"
                />
            );
        });

        expect(storage.getItem('happier.sessionPaneState.v1:session:history-preference')).toBeNull();

        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history-preference"
                    scopeState={openScopeState}
                    urlState={{ bottomTabId: 'terminal' }}
                    pane={pane}
                    setParams={setParams}
                    __updateToken="replayed-from-url"
                />
            );
        });

        expect(storage.getItem('happier.sessionPaneState.v1:session:history-preference')).toBeNull();
    });

    it('does not immediately overwrite URL params while applying initial URL state into pane state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        const urlState = {
            rightTabId: 'files' as const,
            bottomTabId: 'terminal' as const,
            details: { kind: 'commit' as const, sha: 'abc1234' },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <React.StrictMode>
                    <Harness
                        enabled={true}
                        scopeState={closedScopeState}
                        urlState={urlState}
                        pane={pane}
                        setParams={setParams}
                    />
                </React.StrictMode>
            );
        });

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({ key: 'commit:abc1234', kind: 'commit' }));
        expect(setParams).toHaveBeenCalledTimes(0);

        // Simulate the immediate follow-up render before pane state reflects reconciliation.
        await act(async () => {
            tree.update(
                <React.StrictMode>
                    <Harness
                        enabled={true}
                        scopeState={closedScopeState}
                        urlState={urlState}
                        pane={pane}
                        setParams={setParams}
                        __updateToken="still-closed"
                    />
                </React.StrictMode>
            );
        });

        expect(setParams).toHaveBeenCalledTimes(0);

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'commit:abc1234',
                        kind: 'commit',
                        title: 'abc1234',
                        resource: { kind: 'commit', sha: 'abc1234' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'commit:abc1234',
            },
        };

        await act(async () => {
            tree.update(
                <React.StrictMode>
                    <Harness
                        enabled={true}
                        scopeState={openScopeState}
                        urlState={urlState}
                        pane={pane}
                        setParams={setParams}
                        __updateToken="opened"
                    />
                </React.StrictMode>
            );
        });

        expect(setParams).toHaveBeenCalledTimes(0);
    });

    it('does not close details on initial mount when url state only specifies right', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'scmReview:working',
                        kind: 'scmReview',
                        title: 'Review',
                        resource: { kind: 'scmReview' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'scmReview:working',
            },
        };

        await act(async () => {
            renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:one"
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files' }}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
        expect(pane.setRightTab).toHaveBeenCalledWith('files');
        expect(pane.closeDetails).toHaveBeenCalledTimes(0);
    });

    it('writes state to url, and applies url changes back into pane state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.history.state = { id: 'history-entry' };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:history"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });
        await flushDeferredSessionPaneHistoryStateWrite();

        expect(setParams).toHaveBeenCalledWith({
            right: 'files',
            bottom: 'terminal',
            details: 'file',
            path: 'src/app.ts',
            sha: undefined,
        });
        expect(windowStub.history.state).toEqual({
            id: 'history-entry',
            happierSessionPane: {
                scopeKey: 'session:history',
                urlSig: 'files|terminal|file|src/app.ts|',
            },
        });

        // Simulate our own setParams being reflected back into the route.
        setParams.mockClear();
        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history"
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                    __updateToken="reflect"
                />
            );
        });

        // No reconciliation should happen for URL updates produced by our own sync.
        expect(pane.closeDetails).toHaveBeenCalledTimes(0);
        expect(pane.closeRight).toHaveBeenCalledTimes(0);
        expect(pane.closeBottom).toHaveBeenCalledTimes(0);

        // Simulate a browser back navigation: URL no longer describes open panes.
        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                    __updateToken="back"
                />
            );
        });

        // The hook should reconcile pane state to match the URL.
        expect(pane.closeDetails).toHaveBeenCalledTimes(1);
        expect(pane.closeRight).toHaveBeenCalledTimes(1);
        expect(pane.closeBottom).toHaveBeenCalledTimes(1);
    });

    it('does not reconcile (close panes) when switching to a different scope key', async () => {
        const setParams = vi.fn();
        const pane1 = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const pane2 = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeKey="session:one"
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane1}
                    setParams={setParams}
                />
            );
        });

        // Simulate navigation to a different session route where URL params no longer describe panes.
        // The hook should treat this as a fresh mount for the new scope and must not call close* on
        // the new pane (regression: session navigation closed details unexpectedly).
        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeKey="session:two"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane2}
                    setParams={setParams}
                    __updateToken="scope-change"
                />
            );
        });

        expect(pane2.closeDetails).toHaveBeenCalledTimes(0);
        expect(pane2.closeRight).toHaveBeenCalledTimes(0);
        expect(pane2.closeBottom).toHaveBeenCalledTimes(0);
    });

    it('does not write params when url already matches the derived scope state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        await act(async () => {
            renderer.create(
                <Harness
                    enabled={true}
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(setParams).toHaveBeenCalledTimes(0);
    });

    it('re-opens panes when browser forward restores pane params', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <Harness
                    enabled={true}
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openRight).toHaveBeenCalledTimes(0);
        expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);

        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeState={closedScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.openDetailsTab).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:src/app.ts',
                kind: 'file',
            })
        );
    });
});
