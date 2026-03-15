import { describe, expect, it, vi } from 'vitest';

import { applySessionPaneUrlState, deriveSessionPaneUrlStateFromScopeState, parseSessionPaneUrlState, reconcileSessionPaneScopeFromUrlState, serializeSessionPaneUrlState } from './sessionPaneUrlState';

describe('sessionPaneUrlState', () => {
    describe('parseSessionPaneUrlState', () => {
        it('returns null when no pane params are present', () => {
            expect(parseSessionPaneUrlState({})).toBeNull();
        });

        it('parses right tab id', () => {
            expect(parseSessionPaneUrlState({ right: 'files' })).toEqual({ rightTabId: 'files' });
            expect(parseSessionPaneUrlState({ right: 'git' })).toEqual({ rightTabId: 'git' });
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
    });

    describe('deriveSessionPaneUrlStateFromScopeState', () => {
        it('derives an active file tab', () => {
            expect(
                deriveSessionPaneUrlStateFromScopeState({
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
                } as any)
            ).toEqual({
                rightTabId: 'files',
                details: { kind: 'file', path: 'src/app.ts' },
            });
        });
    });

    describe('reconcileSessionPaneScopeFromUrlState', () => {
        it('closes right and details when url state is null', () => {
            const pane = {
                openRight: vi.fn(),
                closeRight: vi.fn(),
                setRightTab: vi.fn(),
                openDetailsTab: vi.fn(),
                closeDetails: vi.fn(),
            };

            reconcileSessionPaneScopeFromUrlState(pane as any, null);

            expect(pane.closeRight).toHaveBeenCalledTimes(1);
            expect(pane.closeDetails).toHaveBeenCalledTimes(1);
            expect(pane.openRight).toHaveBeenCalledTimes(0);
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });

        it('closes details when url state omits details', () => {
            const pane = {
                openRight: vi.fn(),
                closeRight: vi.fn(),
                setRightTab: vi.fn(),
                openDetailsTab: vi.fn(),
                closeDetails: vi.fn(),
            };

            reconcileSessionPaneScopeFromUrlState(pane as any, { rightTabId: 'files' });

            expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files' });
            expect(pane.setRightTab).toHaveBeenCalledWith('files');
            expect(pane.closeDetails).toHaveBeenCalledTimes(1);
            expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        });

        it('closes right when url state omits right', () => {
            const pane = {
                openRight: vi.fn(),
                closeRight: vi.fn(),
                setRightTab: vi.fn(),
                openDetailsTab: vi.fn(),
                closeDetails: vi.fn(),
            };

            reconcileSessionPaneScopeFromUrlState(pane as any, { details: { kind: 'commit', sha: '0338a0f' } });

            expect(pane.closeRight).toHaveBeenCalledTimes(1);
            expect(pane.openDetailsTab).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: 'commit:0338a0f',
                    kind: 'commit',
                })
            );
        });
    });
});
