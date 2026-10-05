import { installFileFindAccountBoundaryMocks } from './fileFindSeedTestHelpers';
import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { LOCAL_SETTING_DEFINITIONS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

installFileFindAccountBoundaryMocks();

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
    it('hands Find launch input once to its exact destination without persisting the query', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        let context: ReturnType<typeof useAppPaneContext> | null = null;
        function Probe() { context = useAppPaneContext(); return null; }
        const screen = await renderScreen(<AppPaneProvider><Probe /></AppPaneProvider>);
        const destination = { host: 'project' as const, id: 'wr_1', accountId: 'account-a', path: 'src/a.ts',
            scope: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' } };
        const seed = { query: 'private needle', options: { matchCase: false, regex: false }, target: { kind: 'file' as const, path: 'src/a.ts' } };
        if (!context) throw new Error('Pane host did not mount');
        const handoff = (context as ReturnType<typeof useAppPaneContext>).fileFindSeedHandoff;
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        handoff.stage(destination, seed, authority);
        expect(handoff.take({ ...destination, accountId: 'account-b' })).toBeNull();
        expect(handoff.take({ ...destination, scope: { ...destination.scope, serverId: 'home-b' } })).toBeNull();
        expect(handoff.take(destination)).toEqual(seed);
        expect(handoff.take(destination)).toBeNull();
        const cancel = handoff.stage(destination, seed, authority);
        cancel();
        expect(handoff.take(destination)).toBeNull();
        expect(JSON.stringify(localSettingsMock)).not.toContain(seed.query);
        handoff.stage(destination, seed, authority);
        await screen.unmount();
        expect(handoff.take(destination)).toBeNull();
    });
    beforeEach(() => {
        standardCleanup();
        localSettingsMock = {};
        setLocalSettingSpy.mockReset();
    });

    it('reveals accepted terminal selections through the matching mounted session driver, never a foreign Home', async () => {
        const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
        const { useRegisterSessionPaneDriver } = await import('@/components/sessions/panes/useRegisterSessionPaneDriver');
        const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const calls: string[] = [];
        let dispatch: ReturnType<typeof useAppPaneContext>['dispatch'] | undefined;
        let scopeId = '';
        function Probe(props: Readonly<{ home: string }>) {
            const register = useSessionCockpitChromeRegister();
            const switchSurface = React.useCallback((surface: string) => { calls.push(`${props.home}:${surface}`); }, [props.home]);
            React.useEffect(() => register({ sessionId: 'same-session', serverId: props.home, activeSurface: 'chat', terminalTabAvailable: true, openDetailsTabCount: 0, switchSurface }), [props.home, register, switchSurface]);
            scopeId = useRegisterSessionPaneDriver('same-session', 'home-a', undefined, {
                pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: 'machine-a', serverId: 'home-a', platform: 'ios',
            });
            dispatch = useAppPaneContext().dispatch;
            return null;
        }
        const harness = (home: string) => <AppPaneProvider><SessionCockpitChromeRegistryProvider><Probe home={home} /></SessionCockpitChromeRegistryProvider></AppPaneProvider>;
        const screen = await renderScreen(harness('home-a'));
        const command = async (command: import('@/components/sessions/terminal/sessionTerminalWorkspace').SessionTerminalWorkspaceCommand) => {
            await act(async () => { dispatch?.({ type: 'terminalWorkspace', scopeId, command }); });
        };
        await command({ type: 'open', terminal: { id: 'shell', target: { kind: 'workspace_shell' } } });
        expect(calls).toEqual(['home-a:terminal']);
        calls.length = 0;
        await command({ type: 'split', terminal: { id: 'rejected', target: { kind: 'workspace_shell' } }, availableWidthPx: 500, minimumTerminalWidthPx: 320 });
        await command({ type: 'focus', terminalId: 'missing' });
        expect(calls).toEqual([]);
        await command({ type: 'split', terminal: { id: 'second', target: { kind: 'workspace_shell' } }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 });
        await command({ type: 'focus', terminalId: 'shell' });
        await command({ type: 'focus', terminalId: 'shell' });
        await command({ type: 'detach', terminalId: 'second', newTabId: 'detached-second' });
        expect(calls).toEqual(['home-a:terminal', 'home-a:terminal', 'home-a:terminal', 'home-a:terminal']);
        calls.length = 0;
        await screen.update(harness('home-b'));
        await command({ type: 'open', terminal: { id: 'other', target: { kind: 'workspace_shell' } } });
        await command({ type: 'focus', terminalId: 'shell' });
        expect(calls).toEqual([]);
        await screen.update(harness('home-a'));
        await command({ type: 'focus', terminalId: 'shell' });
        expect(calls).toEqual(['home-a:terminal']);
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
