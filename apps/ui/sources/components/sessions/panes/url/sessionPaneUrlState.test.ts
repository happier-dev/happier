import { describe, expect, it, vi } from 'vitest';

import { applySessionPaneUrlState, buildActiveDetailsRouteParams, createSessionPaneDetailsTab, deriveSessionPaneUrlStateFromScopeState, parseSessionPaneUrlState, reconcileSessionPaneScopeFromUrlState, serializeSessionPaneUrlState } from './sessionPaneUrlState';

describe('sessionPaneUrlState', () => {
    it('constructs independent route-selected surfaces without writing shared pane selection', () => {
        const address = { serverId: 'home-a', sessionId: 'same-session' };
        const first = createSessionPaneDetailsTab({ kind: 'file', path: 'src/first.ts' }, address);
        const second = createSessionPaneDetailsTab({ kind: 'file', path: 'src/second.ts' }, address);
        expect(buildActiveDetailsRouteParams([first], first?.key ?? null)).toEqual({ details: 'file', path: 'src/first.ts' });
        expect(buildActiveDetailsRouteParams([second], second?.key ?? null)).toEqual({ details: 'file', path: 'src/second.ts' });
        expect(first).toMatchObject({ isPinned: true, isPreview: false, resource: { path: 'src/first.ts' } });
        const discussion = createSessionPaneDetailsTab({ kind: 'discussion', discussionId: 'discussion-1' }, address);
        expect(discussion?.resource).toMatchObject({ target: { address, discussionId: 'discussion-1' } });
        expect(createSessionPaneDetailsTab({ kind: 'discussion', discussionId: 'discussion-1' })).toBeNull();
        expect(createSessionPaneDetailsTab({ kind: 'file', path: '../private' }, address)).toBeNull();
        expect(createSessionPaneDetailsTab({ kind: 'scmPullRequest' }, address)?.resource).toEqual({ kind: 'scmPullRequest' });
        expect(createSessionPaneDetailsTab({ kind: 'board', focusTarget: { kind: 'item', itemId: 'board-item' } }, address)?.resource).toEqual({ kind: 'board', focusTarget: { kind: 'item', itemId: 'board-item' } });
    });

    it('carries the Files comparison and view through the link and the tab, so a turn card opens that exact turn', () => {
        const address = { serverId: 'home-a', sessionId: 'session-1' };
        const parsed = parseSessionPaneUrlState({ details: 'scmReview', comparison: 'turnCheckpoint', turnId: 'turn-4', view: 'files' });
        expect(parsed).toEqual({ details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4' }, view: 'files' } });
        if (!parsed?.details) throw new Error('Expected the review destination to parse');
        expect(serializeSessionPaneUrlState(parsed)).toEqual({ details: 'scmReview', comparison: 'turnCheckpoint', turnId: 'turn-4', view: 'files' });
        const tab = createSessionPaneDetailsTab(parsed.details, address);
        expect(tab?.key).toBe('scmReview:working');
        expect(tab?.resource).toEqual({ kind: 'scmReview', scope: 'working', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4' }, view: 'files' });
        // The tab says which view of which comparison it shows (lab WT8: "Files · This session").
        expect(tab?.title).toBe('Files · Turn');
        expect(createSessionPaneDetailsTab({ kind: 'scmReview', comparison: { kind: 'session' }, view: 'files' }, address)?.title).toBe('Files · This session');
        expect(createSessionPaneDetailsTab({ kind: 'scmReview', comparison: { kind: 'workingTree' } }, address)?.title).toBe('Files · Pending changes');
        expect(buildActiveDetailsRouteParams([tab], tab?.key ?? null)).toEqual({ details: 'scmReview', comparison: 'turnCheckpoint', turnId: 'turn-4', view: 'files' });
        expect(deriveSessionPaneUrlStateFromScopeState({
            right: { isOpen: false, activeTabId: null },
            bottom: { isOpen: false, activeTabId: null },
            details: { isOpen: true, tabs: [tab!], activeTabKey: tab!.key },
        })).toEqual({ details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4' }, view: 'files' } });

        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'branch', head: 'feature', base: 'main' })?.details)
            .toEqual({ kind: 'scmReview', comparison: { kind: 'branch', head: 'feature', base: 'main' } });
        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'commit', commit: 'abc1234' })?.details)
            .toEqual({ kind: 'scmReview', comparison: { kind: 'commit', commit: 'abc1234' } });
        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'turnCheckpoint', turnId: 'turn-4', evidence: 'checkpoint' })?.details)
            .toEqual({ kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4', evidence: 'checkpoint' } });
        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'turnCheckpoint', turnId: 'turn-4', evidence: 'guess' })?.details)
            .toEqual({ kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4' } });
        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'session' })?.details)
            .toEqual({ kind: 'scmReview', comparison: { kind: 'session' } });
        // An incomplete selector is not guessed: the link opens the default comparison instead of a wrong one.
        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'turnCheckpoint' })?.details).toEqual({ kind: 'scmReview' });
        expect(parseSessionPaneUrlState({ details: 'scmReview', comparison: 'branch', head: 'feature' })?.details).toEqual({ kind: 'scmReview' });
        expect(parseSessionPaneUrlState({ details: 'scmReview', view: 'sideways' })?.details).toEqual({ kind: 'scmReview' });
    });

    describe('parseSessionPaneUrlState', () => {
        it('returns null when no pane params are present', () => {
            expect(parseSessionPaneUrlState({})).toBeNull();
        });

        it('parses right tab id', () => {
            expect(parseSessionPaneUrlState({ right: 'collaboration' })).toEqual({ rightTabId: 'collaboration' });
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

        it('parses SCM review details target', () => {
            expect(parseSessionPaneUrlState({ details: 'scmReview' })).toEqual({
                details: { kind: 'scmReview' },
            });
        });

        it('parses SCM stash details target', () => {
            expect(parseSessionPaneUrlState({ details: 'scmStash' })).toEqual({
                details: { kind: 'scmStash' },
            });
        });

        it('reopens the new pull request destination from its link', () => {
            const parsed = parseSessionPaneUrlState({ details: 'scmPullRequest' });
            expect(parsed).toEqual({ details: { kind: 'scmPullRequest' } });
            if (!parsed) throw new Error('Expected the pull request destination to parse');
            const pane = { openRight: vi.fn(), setRightTab: vi.fn(), openBottom: vi.fn(), setBottomTab: vi.fn(), openDetailsTab: vi.fn() };
            applySessionPaneUrlState(pane as any, parsed);
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({ key: 'scmPullRequest', kind: 'scmPullRequest', resource: { kind: 'scmPullRequest' } }),
                { intent: 'pinned' },
            );
        });

        it('parses terminal details target', () => {
            expect(parseSessionPaneUrlState({ details: 'terminal' })).toEqual({
                details: { kind: 'terminal' },
            });
        });

        it('parses terminal details target with an explicit terminal instance id', () => {
            expect(parseSessionPaneUrlState({ details: 'terminal', terminalInstanceId: 'term-7' })).toEqual({
                details: { kind: 'terminal', terminalInstanceId: 'term-7' },
            });
        });

        it('parses exact discussion details targets without parsing the Session address from a compound key', () => {
            expect(parseSessionPaneUrlState({
                details: 'discussion',
                discussionId: 'discussion:1',
            })).toEqual({
                details: { kind: 'discussion', discussionId: 'discussion:1' },
            });
            expect(parseSessionPaneUrlState({ details: 'discussion' })).toBeNull();
        });

        it('parses a Board item as a typed focus target without parsing a compound tab key', () => {
            expect(parseSessionPaneUrlState({
                details: 'board',
                boardItemId: 'item:with:colons',
            })).toEqual({
                details: { kind: 'board', focusTarget: { kind: 'item', itemId: 'item:with:colons' } },
            });
            expect(parseSessionPaneUrlState({ details: 'board' })).toEqual({
                details: { kind: 'board' },
            });
        });
    });

    describe('applySessionPaneUrlState', () => {
        it('opens the exact Board item through the typed Details tab owner', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'board', focusTarget: { kind: 'item', itemId: 'item:with:colons' } },
            });

            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'board',
                    resource: {
                        kind: 'board',
                        focusTarget: { kind: 'item', itemId: 'item:with:colons' },
                    },
                }),
                { intent: 'pinned' },
            );
        });
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
                    resource: expect.objectContaining({
                        kind: 'terminal',
                        terminalInstanceId: 'embedded',
                    }),
                }),
                { intent: 'pinned' },
            );
        });

        it('restores an explicit terminal details instance from url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'terminal', terminalInstanceId: 'term-7' },
            });

            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'terminal:term-7',
                    kind: 'terminal',
                    resource: expect.objectContaining({
                        kind: 'terminal',
                        terminalInstanceId: 'term-7',
                    }),
                }),
                { intent: 'pinned' },
            );
        });

        it('opens the SCM review details tab when requested in url state', () => {
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

            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'scmReview:working',
                    kind: 'scmReview',
                    resource: { kind: 'scmReview', scope: 'working' },
                }),
                { intent: 'pinned' },
            );
        });

        it('opens the SCM stash details tab when requested in url state', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'scmStash' },
            });

            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'scmStash',
                    kind: 'scmStash',
                    resource: { kind: 'scmStash' },
                }),
                { intent: 'pinned' },
            );
        });

        it('opens a discussion using the separately supplied exact Session address', () => {
            const pane = {
                openRight: vi.fn(),
                setRightTab: vi.fn(),
                openBottom: vi.fn(),
                setBottomTab: vi.fn(),
                openDetailsTab: vi.fn(),
            };

            applySessionPaneUrlState(pane as any, {
                details: { kind: 'discussion', discussionId: 'discussion:1' },
            }, { serverId: 'home:a', sessionId: 'session:1' });

            expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({
                key: 'discussion:["home:a","session:1"]:discussion:1',
                resource: {
                    kind: 'discussion',
                    target: {
                        kind: 'discussion',
                        address: { serverId: 'home:a', sessionId: 'session:1' },
                        discussionId: 'discussion:1',
                    },
                },
            }));
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

        it('serializes SCM review details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    details: { kind: 'scmReview' },
                })
            ).toEqual({
                details: 'scmReview',
            });
        });

        it('serializes SCM stash details state', () => {
            expect(
                serializeSessionPaneUrlState({
                    details: { kind: 'scmStash' },
                })
            ).toEqual({
                details: 'scmStash',
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

        it('serializes terminal details state with an explicit terminal instance id', () => {
            expect(
                serializeSessionPaneUrlState({
                    details: { kind: 'terminal', terminalInstanceId: 'term-7' },
                })
            ).toEqual({
                details: 'terminal',
                terminalInstanceId: 'term-7',
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
                                key: 'terminal:terminal-instance-7',
                                kind: 'terminal',
                                title: 'Terminal',
                                resource: { kind: 'terminal', terminalInstanceId: 'terminal-instance-7' },
                                isPinned: true,
                                isPreview: false,
                            },
                        ],
                        activeTabKey: 'terminal:terminal-instance-7',
                    },
                } as any)
            ).toEqual({
                details: { kind: 'terminal', terminalInstanceId: 'terminal-instance-7' },
            });
        });

        it('derives an active SCM review details tab', () => {
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

        it('derives an active SCM stash details tab', () => {
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

        it('keeps legacy singleton terminal details tabs routable during migration', () => {
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
    });

    describe('buildActiveDetailsRouteParams', () => {
        it('serializes an active SCM review details tab into route params', () => {
            expect(buildActiveDetailsRouteParams([
                {
                    key: 'scmReview:working',
                    kind: 'scmReview',
                    resource: { kind: 'scmReview', scope: 'working' },
                },
            ], 'scmReview:working')).toEqual({
                details: 'scmReview',
            });
        });

        it('serializes an active SCM stash details tab into route params', () => {
            expect(buildActiveDetailsRouteParams([
                {
                    key: 'scmStash',
                    kind: 'scmStash',
                    resource: { kind: 'scmStash' },
                },
            ], 'scmStash')).toEqual({
                details: 'scmStash',
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
