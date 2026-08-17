import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { LOCAL_SETTING_DEFINITIONS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setLocalSettingSpy = vi.hoisted(() => vi.fn());
let localSettingsMock: Record<string, unknown> = {};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            (value: unknown) => {
                localSettingsMock[key] = value;
                setLocalSettingSpy(value);
            },
        ],
    });
});

function PaneScopeProbe(props: Readonly<{ triggerOpenDetails?: boolean }>) {
    const pane = useAppPaneScope('project:wr_1');
    const hasTriggeredRef = React.useRef(false);

    React.useEffect(() => {
        if (!props.triggerOpenDetails) return;
        if (hasTriggeredRef.current) return;
        hasTriggeredRef.current = true;
        pane.openDetailsTab(
            {
                key: 'file:/repo/src/a.ts',
                kind: 'file',
                title: 'a.ts',
                resource: { kind: 'file', path: '/repo/src/a.ts' },
            },
            { intent: 'pinned' },
        );
        pane.setDetailsTabState('file:/repo/src/a.ts', { draft: 'draft text' });
    }, [pane, props.triggerOpenDetails]);

    return React.createElement('PaneScopeProbe', {
        scopeState: pane.scopeState,
    });
}

describe('AppPaneProvider persistence', () => {
    beforeEach(() => {
        standardCleanup();
        localSettingsMock = {};
        setLocalSettingSpy.mockReset();
    });

    it('hydrates persisted pane scopes from local settings on mount', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'project:wr_1': {
                    right: { isOpen: true, activeTabId: 'git', tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'file:/repo/src/a.ts',
                                kind: 'file',
                                title: 'a.ts',
                                resource: { kind: 'file', path: '/repo/src/a.ts' },
                                isPreview: false,
                                isPinned: true,
                            },
                        ],
                        activeTabKey: 'file:/repo/src/a.ts',
                        tabState: {
                            'file:/repo/src/a.ts': { draft: 'draft text' },
                        },
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
        };

        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe />
            </AppPaneProvider>,
        );

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState).toEqual(expect.objectContaining({
            right: expect.objectContaining({
                isOpen: true,
                activeTabId: 'git',
                selectedDestination: { kind: 'builtin', id: 'git' },
            }),
            details: expect.objectContaining({
                isOpen: true,
                activeTabKey: 'file:/repo/src/a.ts',
                focusedGroupId: 'group:1',
                groups: [
                    expect.objectContaining({
                        id: 'group:1',
                        activeTabKey: 'file:/repo/src/a.ts',
                        tabKeys: ['file:/repo/src/a.ts'],
                    }),
                ],
                tabState: {
                    'file:/repo/src/a.ts': { draft: 'draft text' },
                },
            }),
        }));
    });

    it('preserves own Details tab keys through the local-setting boundary and removes inherited-only group references', async () => {
        const tabKey = '__proto__';
        localSettingsMock = {
            appPaneScopesV1: LOCAL_SETTING_DEFINITIONS.appPaneScopesV1.schema.parse(JSON.parse(JSON.stringify({
                'project:wr_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabState: { [tabKey]: { scrollY: 240 } },
                        tabsByKey: {
                            [tabKey]: {
                                key: tabKey,
                                kind: 'file',
                                title: 'prototype-safe.ts',
                                resource: { kind: 'file', path: '/repo/prototype-safe.ts' },
                                isPreview: false,
                                isPinned: true,
                            },
                        },
                        groupsById: {
                            'group:1': {
                                id: 'group:1',
                                tabKeys: [tabKey, 'constructor'],
                                activeTabKey: tabKey,
                            },
                        },
                        root: {
                            id: 'group:1',
                            kind: 'leaf',
                            leafKind: 'details-group',
                            payload: { groupId: 'group:1' },
                        },
                        focusedGroupId: 'group:1',
                        maximizedGroupId: null,
                        nextGroupOrdinal: 2,
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            }))),
        };

        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe />
            </AppPaneProvider>,
        );

        const scopeState = screen.tree.findByType('PaneScopeProbe' as never).props.scopeState;
        if (!scopeState) throw new Error('Expected hydrated pane scope state');

        expect(scopeState.details.tabs).toEqual([
            expect.objectContaining({ key: tabKey }),
        ]);
        expect(scopeState.details.groups).toEqual([
            expect.objectContaining({
                id: 'group:1',
                tabKeys: [tabKey],
                activeTabKey: tabKey,
            }),
        ]);
        expect(Object.prototype.hasOwnProperty.call(scopeState.details.tabState, tabKey)).toBe(true);
        expect(scopeState.details.tabState[tabKey]).toEqual({ scrollY: 240 });
        expect(setLocalSettingSpy).toHaveBeenCalled();
        const roundTrippedScopes = LOCAL_SETTING_DEFINITIONS.appPaneScopesV1.schema.parse(
            localSettingsMock.appPaneScopesV1,
        );
        expect(roundTrippedScopes).toEqual(expect.objectContaining({
            'project:wr_1': expect.objectContaining({
                details: expect.objectContaining({
                    tabsByKey: expect.objectContaining({
                        [tabKey]: expect.objectContaining({ key: tabKey }),
                    }),
                    groupsById: {
                        'group:1': {
                            id: 'group:1',
                            tabKeys: [tabKey],
                            activeTabKey: tabKey,
                        },
                    },
                }),
            }),
        }));
    });

    it('persists pane scope updates back to local settings', async () => {
        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe triggerOpenDetails={false} />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <PaneScopeProbe triggerOpenDetails />
                </AppPaneProvider>,
            );
        });

        expect(setLocalSettingSpy).toHaveBeenCalledWith(expect.objectContaining({
            'project:wr_1': expect.objectContaining({
                details: expect.objectContaining({
                    focusedGroupId: 'group:1',
                    root: {
                        id: 'group:1',
                        kind: 'leaf',
                        leafKind: 'details-group',
                        payload: { groupId: 'group:1' },
                    },
                    tabsByKey: expect.objectContaining({
                        'file:/repo/src/a.ts': expect.objectContaining({
                            isPinned: true,
                            isPreview: false,
                        }),
                    }),
                    groupsById: {
                        'group:1': {
                            id: 'group:1',
                            tabKeys: ['file:/repo/src/a.ts'],
                            activeTabKey: 'file:/repo/src/a.ts',
                        },
                    },
                    tabState: {
                        'file:/repo/src/a.ts': { draft: 'draft text' },
                    },
                }),
            }),
        }));
    });

    it('hydrates persisted pane scopes that arrive after the initial mount', async () => {
        const persistedScopes = {
            'project:wr_1': {
                right: { isOpen: true, activeTabId: 'git', tabState: {} },
                details: {
                    isOpen: true,
                    tabs: [
                        {
                            key: 'file:/repo/src/a.ts',
                            kind: 'file',
                            title: 'a.ts',
                            resource: { kind: 'file', path: '/repo/src/a.ts' },
                            isPreview: false,
                            isPinned: true,
                        },
                    ],
                    activeTabKey: 'file:/repo/src/a.ts',
                    tabState: {
                        'file:/repo/src/a.ts': { draft: 'draft text' },
                    },
                },
                bottom: { isOpen: false, activeTabId: null, tabState: {} },
            },
        };

        const { AppPaneProvider } = await import('./AppPaneProvider');
        const screen = await renderScreen(
            <AppPaneProvider>
                <PaneScopeProbe />
            </AppPaneProvider>,
        );

        localSettingsMock.appPaneScopesV1 = persistedScopes;

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <PaneScopeProbe />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState).toEqual(expect.objectContaining({
            right: expect.objectContaining({
                isOpen: true,
                activeTabId: 'git',
                selectedDestination: { kind: 'builtin', id: 'git' },
            }),
            details: expect.objectContaining({
                isOpen: true,
                activeTabKey: 'file:/repo/src/a.ts',
                focusedGroupId: 'group:1',
                groups: [
                    expect.objectContaining({
                        id: 'group:1',
                        activeTabKey: 'file:/repo/src/a.ts',
                        tabKeys: ['file:/repo/src/a.ts'],
                    }),
                ],
                tabState: {
                    'file:/repo/src/a.ts': { draft: 'draft text' },
                },
            }),
        }));
    });
});
