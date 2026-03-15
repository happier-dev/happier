import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useSessionPaneUrlSync } from './useSessionPaneUrlSync';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: any) {
    useSessionPaneUrlSync(props);
    return null;
}

describe('useSessionPaneUrlSync', () => {
    it('does not immediately overwrite URL params while applying initial URL state into pane state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        const urlState = { rightTabId: 'files' as const, details: { kind: 'commit' as const, sha: 'abc1234' } };

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

    it('writes state to url, and applies url changes back into pane state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
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
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(setParams).toHaveBeenCalledWith({
            right: 'files',
            details: 'file',
            path: 'src/app.ts',
            sha: undefined,
        });

        // Simulate our own setParams being reflected back into the route.
        setParams.mockClear();
        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                    __updateToken="reflect"
                />
            );
        });

        // No reconciliation should happen for URL updates produced by our own sync.
        expect(pane.closeDetails).toHaveBeenCalledTimes(0);
        expect(pane.closeRight).toHaveBeenCalledTimes(0);

        // Simulate a browser back navigation: URL no longer describes open panes.
        await act(async () => {
            tree.update(
                <Harness
                    enabled={true}
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
    });

    it('does not write params when url already matches the derived scope state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
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
                    urlState={{ rightTabId: 'files', details: { kind: 'file', path: 'src/app.ts' } }}
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
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
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
                    urlState={{ rightTabId: 'files', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />
            );
        });

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
        expect(pane.openDetailsTab).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:src/app.ts',
                kind: 'file',
            })
        );
    });
});
