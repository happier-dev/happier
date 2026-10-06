import * as React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import type { PluginProjectionV2 } from '@happier-dev/protocol';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { SessionHeaderBrowserButton } from '@/components/sessions/actions/SessionHeaderBrowserButton';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { SESSION_BOARD_DESTINATION } from '@/components/sessions/board/sessionBoardDestination';
import { t } from '@/text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SESSION_HEADER_ACTION_TAP_TARGET_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';

import { resolveSessionViewHeaderProps } from './resolveSessionViewHeaderProps';

function findHeaderActionMenu(props: ReturnType<typeof resolveSessionViewHeaderProps>): React.ReactElement<any> {
    const children = React.Children.toArray(
        (props.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
    );
    const menu = children.find((child) => (
        React.isValidElement(child) && child.type === SessionHeaderActionMenu
    ));
    expect(menu).toBeDefined();
    return menu as React.ReactElement<any>;
}

function findBoardHeaderButton(props: ReturnType<typeof resolveSessionViewHeaderProps>): React.ReactElement<any> | undefined {
    const children = React.Children.toArray(
        (props.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
    );
    return children.find((child) => (
        React.isValidElement<{ testID?: string }>(child)
        && child.props.testID === 'session-header-board-button'
    )) as React.ReactElement<any> | undefined;
}

function createPluginHeaderProjection() {
    return normalizePluginUiProjection({
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {
            'acme.preview/run': {
                id: 'run',
                pluginId: 'acme.preview',
                occurrenceId: 'acme.preview:run:occurrence',
                title: 'Run preview',
                scopes: ['session'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                available: true,
            },
        },
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'sessionHeaderAction:acme.preview:run': {
                        id: 'sessionHeaderAction:acme.preview:run',
                        pluginId: 'acme.preview',
                        occurrenceId: 'acme.preview:run:occurrence',
                        contributionKind: 'sessionHeaderAction',
                        descriptorId: 'run',
                        title: 'Run preview',
                        order: 0,
                        command: {
                            kind: 'executeAction',
                            action: { pluginId: 'acme.preview', localId: 'run' },
                        },
                    },
                    'sessionHeaderAction:acme.preview:open': {
                        id: 'sessionHeaderAction:acme.preview:open',
                        pluginId: 'acme.preview',
                        occurrenceId: 'acme.preview:open:occurrence',
                        contributionKind: 'sessionHeaderAction',
                        descriptorId: 'open',
                        title: 'Open preview',
                        order: 5,
                        command: {
                            kind: 'openSurface',
                            destination: { pluginId: 'acme.preview', localId: 'preview' },
                        },
                    },
                },
            },
        },
        diagnostics: [],
    });
}

function createManyPluginHeaderProjection(actionCount: number) {
    const actionsById = Object.fromEntries(Array.from({ length: actionCount }, (_value, index) => {
        const localId = `action-${index + 1}`;
        return [`acme.preview/${localId}`, {
            id: localId,
            pluginId: 'acme.preview',
            occurrenceId: `acme.preview:${localId}:occurrence`,
            title: `Action ${index + 1}`,
            scopes: ['session'] as Array<'session'>,
            surfaces: ['ui'] as Array<'ui'>,
            execution: { target: 'daemon' as const },
            placementBindings: ['detailsPanel'] as Array<'detailsPanel'>,
            dangerLevel: 'safe' as const,
            available: true,
        }];
    }));
    const entriesById = Object.fromEntries(Array.from({ length: actionCount }, (_value, index) => {
        const localId = `action-${index + 1}`;
        const id = `sessionHeaderAction:acme.preview:${localId}`;
        return [id, {
            id,
            pluginId: 'acme.preview',
            occurrenceId: `acme.preview:${localId}:occurrence`,
            contributionKind: 'sessionHeaderAction' as const,
            descriptorId: localId,
            title: `Action ${index + 1}`,
            order: index,
            command: {
                kind: 'executeAction' as const,
                action: { pluginId: 'acme.preview', localId },
            },
        }];
    }));

    return normalizePluginUiProjection({
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        actionsById,
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById,
            },
        },
        diagnostics: [],
    } satisfies PluginProjectionV2);
}

describe('resolveSessionViewHeaderProps owner metadata', () => {
    it('removes duplicate rail and mobile terminal icons while preserving fallback access and desktop browser', () => {
        const session = createSessionFixture({ id: 'header-rail-access' });
        const input = {
            isDataReady: true, session, sessionId: session.id,
            sessionInfoHref: '/session/header-rail-access/info',
            sessionRunsHref: '/session/header-rail-access/runs',
            sessionAutomationsHref: '/session/header-rail-access/automations',
            paneScopeId: 'header-rail-access', windowWidth: 1400,
            sessionAutomationsEnabledCount: 0, sessionExecutionRunsSupported: true,
            showAutomations: false, shouldShowSubagentsButton: true, subagentActiveCount: 1,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000', headerTintColor: '#000', statusErrorColor: '#f00',
            externalSessionRuntime: null,
        };
        const types = (value: ReturnType<typeof resolveSessionViewHeaderProps>) => React.Children.toArray(
            (value.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
        ).filter(React.isValidElement).map((child) => child.type);
        const fallback = types(resolveSessionViewHeaderProps(input));
        expect(fallback).toContain(SessionHeaderSubagentsButton);
        expect(fallback).toContain(SessionHeaderTerminalButton);
        const rail = types(resolveSessionViewHeaderProps({ ...input, actionRailVisible: true }));
        expect(rail).not.toContain(SessionHeaderSubagentsButton);
        expect(rail).not.toContain(SessionHeaderTerminalButton);
        expect(rail).toContain(SessionHeaderBrowserButton);
        const mobile = types(resolveSessionViewHeaderProps({ ...input, mobileTerminalTabAvailable: true }));
        expect(mobile).not.toContain(SessionHeaderTerminalButton);
        expect(mobile).toContain(SessionHeaderSubagentsButton);
        expect(types(resolveSessionViewHeaderProps(input))).toContain(SessionHeaderTerminalButton);
        const boardHeaderAction = { onPress: () => {}, preferDirect: true };
        expect(findBoardHeaderButton(resolveSessionViewHeaderProps({ ...input, boardHeaderAction }))).toBeDefined();
        expect(findBoardHeaderButton(resolveSessionViewHeaderProps({ ...input, boardHeaderAction, actionRailVisible: true }))).toBeUndefined();

    });

    it('keeps a deduplicated workspace conflict discoverable from the session header', () => {
        const session = createSessionFixture({ id: 'workspace-conflict-header' });
        const onOpenWorkspaceSyncConflicts = vi.fn();
        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/workspace-conflict-header/info',
            sessionRunsHref: '/session/workspace-conflict-header/runs',
            sessionAutomationsHref: '/session/workspace-conflict-header/automations',
            paneScopeId: 'pane-1',
            windowWidth: 390,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            workspaceSyncAttention: { conflictedLinkCount: 1, unknownLinkCount: 0 },
            onOpenWorkspaceSyncConflicts,
        });
        const children = React.Children.toArray(
            (result.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
        );
        const conflictButtons = children.filter((child): child is React.ReactElement<{
            accessibilityRole?: string;
            accessibilityLabel?: string;
            onPress?: () => void;
        }> => React.isValidElement<{ onPress?: () => void }>(child)
            && child.props.onPress === onOpenWorkspaceSyncConflicts);

        expect(conflictButtons).toHaveLength(1);
        expect(conflictButtons[0].props.accessibilityRole).toBe('button');
        expect(conflictButtons[0].props.accessibilityLabel).toBe(
            t('workspaceSync.attention.conflictedLinks', { count: 1 }),
        );
        conflictButtons[0].props.onPress?.();
        expect(onOpenWorkspaceSyncConflicts).toHaveBeenCalledTimes(1);
    });

    it('keeps one direct plugin action but moves a large ordered header contribution list into overflow', () => {
        const session = createSessionFixture({ id: 'plugin-header-layout' });
        const input = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/plugin-header-layout/info',
            sessionRunsHref: '/session/plugin-header-layout/runs',
            sessionAutomationsHref: '/session/plugin-header-layout/automations',
            paneScopeId: 'pane-1',
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: {
                push: () => {},
                navigate: () => {},
            },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
        } as const;

        const wide = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: createManyPluginHeaderProjection(12),
            windowWidth: 800,
        }));
        const narrow = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: createManyPluginHeaderProjection(12),
            windowWidth: 390,
        }));
        const oneWide = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: createManyPluginHeaderProjection(1),
            windowWidth: 800,
        }));
        const oneNarrow = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: createManyPluginHeaderProjection(1),
            windowWidth: 390,
        }));
        const oneWideBesideBoard = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: createManyPluginHeaderProjection(1),
            boardHeaderAction: { onPress: () => {}, preferDirect: true },
            windowWidth: 800,
        }));

        expect(wide.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(narrow.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(oneWide.props.pluginHeaderActionPlacement).toBe('direct');
        expect(oneNarrow.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(oneWideBesideBoard.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(wide.props.pluginHeaderActions).toEqual(
            expect.arrayContaining(Array.from({ length: 12 }, (_value, index) => expect.objectContaining({
                action: expect.objectContaining({
                    descriptorId: `action-${index + 1}`,
                    command: expect.objectContaining({ kind: 'executeAction' }),
                }),
            }))),
        );
        expect(wide.props.pluginHeaderActions.map((entry: any) => entry.action.descriptorId)).toEqual([
            'action-1',
            'action-2',
            'action-3',
            'action-4',
            'action-5',
            'action-6',
            'action-7',
            'action-8',
            'action-9',
            'action-10',
            'action-11',
            'action-12',
        ]);
        expect(narrow.props.pluginHeaderActions).toEqual(wide.props.pluginHeaderActions);
        expect(oneWide.props.pluginHeaderActions.map((entry: any) => entry.action.descriptorId)).toEqual(['action-1']);
    });

    it('places Board through the shared optional-action budget', () => {
        const session = createSessionFixture({ id: 'board-header-layout' });
        const onPress = () => {};
        const input = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/board-header-layout/info',
            sessionRunsHref: '/session/board-header-layout/runs',
            sessionAutomationsHref: '/session/board-header-layout/automations',
            paneScopeId: 'pane-1',
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
        } as const;

        const emptyWide = resolveSessionViewHeaderProps({
            ...input,
            windowWidth: 800,
            boardHeaderAction: { onPress, preferDirect: false },
        });
        const populatedWide = resolveSessionViewHeaderProps({
            ...input,
            windowWidth: 800,
            boardHeaderAction: { onPress, preferDirect: true },
        });
        const populatedNarrow = resolveSessionViewHeaderProps({
            ...input,
            windowWidth: 390,
            boardHeaderAction: { onPress, preferDirect: true },
        });

        expect(findBoardHeaderButton(emptyWide)).toBeUndefined();
        expect(findHeaderActionMenu(emptyWide).props.extraItems).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'header.openBoard' }),
        ]));
        expect(findBoardHeaderButton(populatedWide)?.props).toEqual(expect.objectContaining({
            onPress,
            accessibilityRole: 'button',
            accessibilityLabel: t(SESSION_BOARD_DESTINATION.labelKey),
        }));
        const boardButton = findBoardHeaderButton(populatedWide);
        const boardButtonStyle = boardButton?.props.style({ pressed: false });
        const expectedTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
        expect(boardButtonStyle).toEqual(expect.objectContaining({
            width: expectedTargetSize,
            height: expectedTargetSize,
        }));
        expect(boardButton?.props.hitSlop).toBe(
            expectedTargetSize > SESSION_HEADER_ACTION_TAP_TARGET_PX ? undefined : 15,
        );
        expect(findHeaderActionMenu(populatedWide).props.extraItems ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'header.openBoard' }),
        ]));
        expect(findBoardHeaderButton(populatedNarrow)).toBeUndefined();
        expect(findHeaderActionMenu(populatedNarrow).props.extraItems).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'header.openBoard' }),
        ]));
    });

    it('gives Board, Companion, and plugin actions one deterministic optional direct slot', () => {
        const session = createSessionFixture({ id: 'shared-optional-header-slot' });
        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/shared-optional-header-slot/info',
            sessionRunsHref: '/session/shared-optional-header-slot/runs',
            sessionAutomationsHref: '/session/shared-optional-header-slot/automations',
            paneScopeId: 'pane-1',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            boardHeaderAction: { onPress: () => {}, preferDirect: true },
            companionHeaderAction: {
                availability: 'ready',
                preferenceExists: true,
                visible: true,
                itemCount: 2,
                placement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
                isPhone: false,
            },
            pluginUiProjection: createManyPluginHeaderProjection(1),
        });
        const menu = findHeaderActionMenu(result);

        expect(findBoardHeaderButton(result)).toBeDefined();
        expect(menu.props.companionHeaderActionPlacement).toBe('overflow');
        expect(menu.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(menu.props.companionHeaderIntent).toMatchObject({
            operation: 'hide',
            checked: true,
            expanded: true,
        });
    });

    it('uses the same optional slot for Companion when Board does not claim it', () => {
        const session = createSessionFixture({ id: 'companion-optional-header-slot' });
        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/companion-optional-header-slot/info',
            sessionRunsHref: '/session/companion-optional-header-slot/runs',
            sessionAutomationsHref: '/session/companion-optional-header-slot/automations',
            paneScopeId: 'pane-1',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            boardHeaderAction: { onPress: () => {}, preferDirect: false },
            companionHeaderAction: {
                availability: 'ready',
                preferenceExists: true,
                visible: true,
                itemCount: 2,
                placement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
                isPhone: false,
            },
            pluginUiProjection: createManyPluginHeaderProjection(1),
        });
        const menu = findHeaderActionMenu(result);

        expect(findBoardHeaderButton(result)).toBeUndefined();
        expect(menu.props.companionHeaderActionPlacement).toBe('direct');
        expect(menu.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(menu.props.companionHeaderIntent).toMatchObject({
            operation: 'hide',
            checked: true,
            expanded: true,
        });
        expect(menu.props.extraItems).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'header.openBoard' }),
        ]));
    });

    it('recomputes the Companion header intent when only its placement facts change', () => {
        // The header props are memoised on a derived cache key. `placement` and
        // `isPhone` are the only inputs of `resolveSessionCompanionHeaderIntent`
        // that no other header fact repeats, so a key that omits them serves a
        // stale intent for the whole Session.
        const session = createSessionFixture({ id: 'companion-placement-cache-key' });
        const input = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/companion-placement-cache-key/info',
            sessionRunsHref: '/session/companion-placement-cache-key/runs',
            sessionAutomationsHref: '/session/companion-placement-cache-key/automations',
            paneScopeId: 'pane-1',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            boardHeaderAction: { onPress: () => {}, preferDirect: false },
            companionHeaderAction: {
                availability: 'ready' as const,
                preferenceExists: true,
                visible: true,
                itemCount: 2,
                placement: { kind: 'reserved_rail' as const, edge: 'trailing' as const, widthPx: 280 },
                isPhone: false,
            },
        };

        const rail = findHeaderActionMenu(resolveSessionViewHeaderProps(input));
        const phone = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            companionHeaderAction: { ...input.companionHeaderAction, isPhone: true },
        }));

        expect(rail.props.companionHeaderIntent).toMatchObject({ operation: 'hide', expanded: true });
        expect(phone.props.companionHeaderIntent).toMatchObject({ operation: 'open_full', expanded: false });
    });

    it('forwards retained projection currentness through the shared direct and overflow header-action presentation', () => {
        const session = createSessionFixture({ id: 'plugin-header-currentness' });
        const input = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/plugin-header-currentness/info',
            sessionRunsHref: '/session/plugin-header-currentness/runs',
            sessionAutomationsHref: '/session/plugin-header-currentness/automations',
            paneScopeId: 'pane-currentness',
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: {
                push: () => {},
                navigate: () => {},
            },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            pluginUiProjection: createPluginHeaderProjection(),
        } as const;
        const revokedFacts = {
            serverId: 'server-projection',
            machineId: 'machine-projection',
            generation: 7,
            interactionEnabled: false,
        };
        const revokedInput = {
            ...input,
            pluginUiScopedLaunchFacts: revokedFacts,
        };

        const revokedWide = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...revokedInput,
            windowWidth: 800,
        }));
        const revokedNarrow = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...revokedInput,
            windowWidth: 390,
        }));

        expect(revokedWide.props.pluginUiScopedLaunchFacts).toBe(revokedFacts);
        expect(revokedNarrow.props.pluginUiScopedLaunchFacts).toBe(revokedFacts);
        expect(revokedWide.props.pluginHeaderActions).toEqual([
            expect.objectContaining({ enabled: false }),
            expect.objectContaining({ enabled: false }),
        ]);
        expect(revokedNarrow.props.pluginHeaderActions).toEqual(revokedWide.props.pluginHeaderActions);

        const reconnectedFacts = {
            ...revokedFacts,
            interactionEnabled: true,
        };
        const reconnectedWide = findHeaderActionMenu(resolveSessionViewHeaderProps({
            ...input,
            pluginUiScopedLaunchFacts: reconnectedFacts,
            windowWidth: 800,
        }));

        expect(reconnectedWide.props.pluginUiScopedLaunchFacts).toBe(reconnectedFacts);
        expect(reconnectedWide.props.pluginHeaderActions).toEqual([
            expect.objectContaining({ enabled: true }),
            expect.objectContaining({ enabled: true }),
        ]);
    });

    it('does not reuse a header element that closes over a same-valued successor plugin authority', async () => {
        const session = createSessionFixture({ id: 'plugin-header-successor-authority' });
        const firstProjection = createPluginHeaderProjection();
        const secondProjection = createPluginHeaderProjection();
        const firstLifetime = { current: true };
        const secondLifetime = { current: true };
        const firstScopeIsCurrent = () => firstLifetime.current;
        const secondScopeIsCurrent = () => secondLifetime.current;
        let firstOpenCalls = 0;
        let secondOpenCalls = 0;
        const firstOpenSurface = async () => {
            firstOpenCalls += 1;
            return { ok: true as const };
        };
        const secondOpenSurface = async () => {
            secondOpenCalls += 1;
            return { ok: true as const };
        };
        const scopedLaunchFacts = {
            serverId: 'server-projection',
            machineId: 'machine-projection',
            generation: 7,
            interactionEnabled: true,
        } as const;
        const input = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/plugin-header-successor-authority/info',
            sessionRunsHref: '/session/plugin-header-successor-authority/runs',
            sessionAutomationsHref: '/session/plugin-header-successor-authority/automations',
            paneScopeId: 'pane-successor-authority',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: {
                push: () => {},
                navigate: () => {},
            },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
            pluginUiScopedLaunchFacts: scopedLaunchFacts,
        } as const;

        const first = resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: firstProjection,
            pluginUiScopeIsCurrent: firstScopeIsCurrent,
            onOpenPluginSurface: firstOpenSurface,
        });
        const second = resolveSessionViewHeaderProps({
            ...input,
            pluginUiProjection: secondProjection,
            pluginUiScopeIsCurrent: secondScopeIsCurrent,
            onOpenPluginSurface: secondOpenSurface,
        });
        const secondMenu = findHeaderActionMenu(second);

        expect(second).not.toBe(first);
        expect(secondMenu.props.pluginUiProjection).toBe(secondProjection);
        expect(secondMenu.props.pluginUiScopeIsCurrent).toBe(secondScopeIsCurrent);
        expect(secondMenu.props.onOpenPluginSurface).toBe(secondOpenSurface);
        firstLifetime.current = false;
        expect(secondMenu.props.pluginUiScopeIsCurrent()).toBe(true);
        await expect(secondMenu.props.onOpenPluginSurface({
            destination: { pluginId: 'acme.preview', localId: 'preview' },
        })).resolves.toEqual({ ok: true });
        expect(firstOpenCalls).toBe(0);
        expect(secondOpenCalls).toBe(1);
    });

    it('invalidates the cached header identity when the Session Agent changes', () => {
        const createInput = (agentId: 'codex' | 'claude') => {
            const session = createSessionFixture({
                id: 'agent-identity-cache-session',
                metadata: {
                    path: '/tmp/project',
                    host: 'test-host',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId,
                        agent: {},
                        provider: {},
                    },
                },
            });
            return {
                isDataReady: true,
                session,
                sessionId: session.id,
                sessionInfoHref: '/session/agent-identity-cache-session/info',
                sessionRunsHref: '/session/agent-identity-cache-session/runs',
                sessionAutomationsHref: '/session/agent-identity-cache-session/automations',
                paneScopeId: 'pane-1',
                windowWidth: 800,
                sessionAutomationsEnabledCount: 0,
                sessionExecutionRunsSupported: false,
                showAutomations: false,
                shouldShowSubagentsButton: false,
                subagentActiveCount: 0,
                navigateWithBlurOnWeb: (action: () => void) => action(),
                handleHeaderExtraItemSelect: () => false,
                router: { push: () => {}, navigate: () => {} },
                actionIconColor: '#000',
                headerTintColor: '#000',
                statusErrorColor: '#f00',
                externalSessionRuntime: null,
            } as const;
        };

        const codex = resolveSessionViewHeaderProps(createInput('codex'));
        const claude = resolveSessionViewHeaderProps(createInput('claude'));

        expect(codex.agentId).toBe('codex');
        expect(claude.agentId).toBe('claude');
        expect(claude).not.toBe(codex);
    });

    it('uses the layout-v1 owner compatibility view for the private workspace subtitle', () => {
        const session = createSessionFixture({
            id: 'layout-v1-session',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
            } as never,
            ownerMetadataView: {
                path: '/Users/private/project',
                host: 'private-host',
                homeDir: '/Users/private',
                machineId: 'private-machine',
            },
        });

        const result = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/layout-v1-session/info',
            sessionRunsHref: '/session/layout-v1-session/runs',
            sessionAutomationsHref: '/session/layout-v1-session/automations',
            paneScopeId: 'pane-1',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: {
                push: () => {},
                navigate: () => {},
            },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
        });

        expect(result.subtitle).toBe('~/project');
    });

    it('keeps an external machine badge when the current machine is different or unknown', () => {
        const session = createSessionFixture({
            id: 'external-session',
            metadata: {
                path: '/tmp/project',
                host: 'remote-host',
                machineId: 'remote-machine',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'remote-machine',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'customArchive' },
                },
            },
        });
        const baseInput = {
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/external-session/info',
            sessionRunsHref: '/session/external-session/runs',
            sessionAutomationsHref: '/session/external-session/automations',
            paneScopeId: 'pane-1',
            windowWidth: 800,
            sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false,
            showAutomations: false,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: {
                push: () => {},
                navigate: () => {},
            },
            actionIconColor: '#000',
            headerTintColor: '#000',
            statusErrorColor: '#f00',
            externalSessionRuntime: null,
        } as const;

        expect(resolveSessionViewHeaderProps({
            ...baseInput,
            currentMachineId: 'current-machine',
        }).badges).toEqual([
            'External',
            'Codex · remote-host',
        ]);
        expect(resolveSessionViewHeaderProps({
            ...baseInput,
            currentMachineId: null,
        }).badges).toEqual([
            'External',
            'Codex · remote-host',
        ]);
    });
});
