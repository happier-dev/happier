import { describe, expect, it, vi } from 'vitest';

import {
    applySessionPaneUrlState,
    buildActiveDetailsRouteParams,
    deriveSessionPaneUrlStateFromScopeState,
    parseSessionPaneUrlState,
    reconcileSessionPaneScopeFromUrlState,
    serializeSessionPaneUrlState,
} from './sessionPaneUrlState';

describe('sessionPaneUrlState', () => {
    describe('parseSessionPaneUrlState', () => {
        it('returns null when no pane params are present', () => {
            expect(parseSessionPaneUrlState({})).toBeNull();
        });

        it('parses right tab id', () => {
            expect(parseSessionPaneUrlState({ right: 'files' })).toEqual({ rightTabId: 'files' });
            expect(parseSessionPaneUrlState({ right: 'git' })).toEqual({ rightTabId: 'git' });
            expect(parseSessionPaneUrlState({ right: 'terminal' })).toEqual({ rightTabId: 'terminal' });
        });

        it('parses bottom terminal tab id', () => {
            expect(parseSessionPaneUrlState({ bottom: 'terminal' })).toEqual({ bottomTabId: 'terminal' });
        });

        it('parses file details target', () => {
            expect(parseSessionPaneUrlState({ details: 'file', path: 'src/app.ts' })).toEqual({
                details: { kind: 'file', path: 'src/app.ts' },
            });
        });

        it('parses file details target with spaces', () => {
            expect(parseSessionPaneUrlState({ details: 'file', path: 'dir/my file.ts' })).toEqual({
                details: { kind: 'file', path: 'dir/my file.ts' },
            });
        });

        it('rejects unsafe file details paths', () => {
            expect(parseSessionPaneUrlState({ details: 'file', path: '/etc/passwd' })).toBeNull();
            expect(parseSessionPaneUrlState({ details: 'file', path: '~/secrets.txt' })).toBeNull();
            expect(parseSessionPaneUrlState({ details: 'file', path: '../secrets.txt' })).toBeNull();
            expect(parseSessionPaneUrlState({ details: 'file', path: 'src/../../secrets.txt' })).toBeNull();
            expect(parseSessionPaneUrlState({ details: 'file', path: 'C:\\\\Windows\\\\system.ini' })).toBeNull();
        });

        it('parses commit details target', () => {
            expect(parseSessionPaneUrlState({ details: 'commit', sha: '0338a0f' })).toEqual({
                details: { kind: 'commit', sha: '0338a0f' },
            });
        });

        it('parses terminal details target', () => {
            expect(parseSessionPaneUrlState({ details: 'terminal' })).toEqual({
                details: { kind: 'terminal' },
            });
        });

        it('parses source-control review details target', () => {
            expect(parseSessionPaneUrlState({ details: 'scmReview' })).toEqual({
                details: { kind: 'scmReview' },
            });
        });

        it('parses source-control stash details target', () => {
            expect(parseSessionPaneUrlState({ details: 'scmStash' })).toEqual({
                details: { kind: 'scmStash' },
            });
        });
    });

    describe('applySessionPaneUrlState', () => {
        it('opens right + details panes from url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                rightTabId: 'files',
                details: { kind: 'file', path: 'apps/ui/sources/index.ts' },
            });

            expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
            expect(pane.setRightTab).toHaveBeenCalledWith('files');
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'file:apps/ui/sources/index.ts',
                    kind: 'file',
                    title: 'index.ts',
                    resource: { kind: 'file', path: 'apps/ui/sources/index.ts' },
                })
            );
        });

        it('opens the terminal tab when requested in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                rightTabId: 'terminal',
            });

            expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'terminal' });
            expect(pane.setRightTab).toHaveBeenCalledWith('terminal');
            expect(pane.openBottom).toHaveBeenCalledTimes(0);
            expect(pane.setBottomTab).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });

        it('opens the bottom terminal tab when requested in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                bottomTabId: 'terminal',
            });

            expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
            expect(pane.setBottomTab).toHaveBeenCalledWith('terminal');
            expect(pane.openRight).toHaveBeenCalledTimes(0);
            expect(pane.setRightTab).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });

        it('opens the details terminal tab when requested in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'terminal' },
            });

            expect(pane.openRight).toHaveBeenCalledTimes(0);
            expect(pane.openBottom).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'terminal:embedded',
                    kind: 'terminal',
                    resource: { kind: 'terminal' },
                }),
                { intent: 'pinned' },
            );
        });

        it('opens the source-control review tab when requested in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'scmReview' },
            });

            expect(pane.openRight).toHaveBeenCalledTimes(0);
            expect(pane.openBottom).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'scmReview:working',
                    kind: 'scmReview',
                    title: expect.any(String),
                    resource: { kind: 'scmReview', scope: 'working' },
                }),
                { intent: 'pinned' },
            );
        });

        it('opens the source-control stash tab when requested in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'scmStash' } as any,
            });

            expect(pane.openRight).toHaveBeenCalledTimes(0);
            expect(pane.openBottom).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'scmStash',
                    kind: 'scmStash',
                    title: expect.any(String),
                    resource: { kind: 'scmStash' },
                }),
                { intent: 'pinned' },
            );
        });

        it('ignores unsafe file paths in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                rightTabId: 'files',
                details: { kind: 'file', path: '/etc/passwd' },
            });

            expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
            expect(pane.setRightTab).toHaveBeenCalledWith('files');
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });
    });

    describe('serializeSessionPaneUrlState', () => {
        it('serializes terminal tab state', () => {
            expect(
                serializeSessionPaneUrlState({
                    rightTabId: 'terminal',
                })
            ).toEqual({
                right: 'terminal',
            });
        });

        it('serializes bottom terminal tab state', () => {
            expect(
                serializeSessionPaneUrlState({
                    bottomTabId: 'terminal',
                })
            ).toEqual({
                bottom: 'terminal',
            });
        });

        it('serializes file details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    rightTabId: 'files',
                    details: { kind: 'file', path: 'src/app.ts' },
                })
            ).toEqual({
                right: 'files',
                details: 'file',
                path: 'src/app.ts',
            });
        });

        it('serializes commit details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    rightTabId: 'git',
                    details: { kind: 'commit', sha: '0338a0f' },
                })
            ).toEqual({
                right: 'git',
                details: 'commit',
                sha: '0338a0f',
            });
        });

        it('serializes terminal details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    details: { kind: 'terminal' },
                })
            ).toEqual({
                details: 'terminal',
            });
        });

        it('serializes source-control review details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    details: { kind: 'scmReview' },
                })
            ).toEqual({
                details: 'scmReview',
            });
        });

        it('serializes source-control stash details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    details: { kind: 'scmStash' } as any,
                })
            ).toEqual({
                details: 'scmStash',
            });
        });
    });

    describe('buildActiveDetailsRouteParams', () => {
        it('serializes active source-control stash details tabs', () => {
            expect(buildActiveDetailsRouteParams([
                {
                    key: 'scmStash',
                    kind: 'scmStash',
                    title: 'Stashed changes',
                    resource: { kind: 'scmStash' },
                },
            ], 'scmStash')).toEqual({
                details: 'scmStash',
            });
        });
    });

    describe('deriveSessionPaneUrlStateFromScopeState', () => {
        it('derives an active file tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
                    right: { isOpen: true, activeTabId: 'files', tabState: {} },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
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
                } as any)
            ).toEqual({
                rightTabId: 'files',
                details: { kind: 'file', path: 'src/app.ts' },
            });
        });

        it('derives an active terminal tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
                    right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                    },
                } as any)
            ).toEqual({
                rightTabId: 'terminal',
            });
        });

        it('derives an active bottom terminal tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                    },
                } as any)
            ).toEqual({
                bottomTabId: 'terminal',
            });
        });

        it('derives an active terminal details tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'terminal:embedded',
                                kind: 'terminal',
                                title: 'Terminal',
                                resource: { kind: 'terminal' },
                                isPinned: true,
                                isPreview: false,
                            },
                        ],
                        activeTabKey: 'terminal:embedded',
                    },
                } as any)
            ).toEqual({
                details: { kind: 'terminal' },
            });
        });

        it('derives an active source-control review details tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'scmReview:working',
                                kind: 'scmReview',
                                title: 'Review',
                                resource: { kind: 'scmReview', scope: 'working' },
                                isPinned: true,
                                isPreview: false,
                            },
                        ],
                        activeTabKey: 'scmReview:working',
                    },
                } as any)
            ).toEqual({
                details: { kind: 'scmReview' },
            });
        });

        it('derives an active source-control stash details tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'scmStash',
                                kind: 'scmStash',
                                title: 'Stashed changes',
                                resource: { kind: 'scmStash' },
                                isPinned: true,
                                isPreview: false,
                            },
                        ],
                        activeTabKey: 'scmStash',
                    },
                } as any)
            ).toEqual({
                details: { kind: 'scmStash' },
            });
        });
    });

    describe('reconcileSessionPaneScopeFromUrlState', () => {
        it('closes right and details when url state is null', () => {
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

            reconcileSessionPaneScopeFromUrlState(pane as any, null);

            expect(pane.closeRight).toHaveBeenCalledTimes(1);
            expect(pane.closeBottom).toHaveBeenCalledTimes(1);
            expect(pane.closeDetails).toHaveBeenCalledTimes(1);
            expect(pane.openRight).toHaveBeenCalledTimes(0);
            expect(pane.openBottom).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });

        it('closes details when url state omits details', () => {
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

            reconcileSessionPaneScopeFromUrlState(pane as any, { rightTabId: 'files' });

            expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
            expect(pane.setRightTab).toHaveBeenCalledWith('files');
            expect(pane.closeBottom).toHaveBeenCalledTimes(1);
            expect(pane.closeDetails).toHaveBeenCalledTimes(1);
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });

        it('closes right when url state omits right', () => {
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

            reconcileSessionPaneScopeFromUrlState(pane as any, { details: { kind: 'commit', sha: '0338a0f' } });

            expect(pane.closeRight).toHaveBeenCalledTimes(1);
            expect(pane.closeBottom).toHaveBeenCalledTimes(1);
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'commit:0338a0f',
                    kind: 'commit',
                })
            );
        });

        it('re-opens the bottom terminal when url state requests it', () => {
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

            reconcileSessionPaneScopeFromUrlState(pane as any, { bottomTabId: 'terminal' });

            expect(pane.closeRight).toHaveBeenCalledTimes(1);
            expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
            expect(pane.setBottomTab).toHaveBeenCalledWith('terminal');
            expect(pane.closeDetails).toHaveBeenCalledTimes(1);
        });
    });
});
