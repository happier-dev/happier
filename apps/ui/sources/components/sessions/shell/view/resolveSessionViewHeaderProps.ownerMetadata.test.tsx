import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderInfoButton } from '@/components/sessions/actions/SessionHeaderInfoButton';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { SESSION_BOARD_DESTINATION } from '@/components/sessions/board/sessionBoardDestination';
import { t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';

import type { Session } from '@/sync/domains/state/storageTypes';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/metadata/systemSessionV1';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';

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
    it('leaves pane-bound header elements with their caller rather than process-global retention', () => {
        const writes = vi.spyOn(LruMap.prototype, 'set');
        try {
            for (let pane = 0; pane < 3; pane++) {
                const session = createSessionFixture({ id: `header-lifetime-${pane}` });
                const select = vi.fn(() => true);
                const header = resolveSessionViewHeaderProps({
                    isDataReady: true, session, sessionId: session.id,
                    sessionInfoHref: `/session/${session.id}/info`,
                    sessionRunsHref: `/session/${session.id}/runs`,
                    sessionAutomationsHref: `/session/${session.id}/automations`,
                    paneScopeId: `pane-${pane}`, windowWidth: 1400,
                    sessionAutomationsEnabledCount: 0, sessionExecutionRunsSupported: true,
                    showAutomations: true, shouldShowSubagentsButton: false, subagentActiveCount: 0,
                    navigateWithBlurOnWeb: action => action(), handleHeaderExtraItemSelect: select,
                    router: { push: () => {}, navigate: () => {} },
                    actionIconColor: '#000', headerTintColor: '#000', statusErrorColor: '#f00',
                    externalSessionRuntime: null,
                });
                findHeaderActionMenu(header).props.onSelectExtraItem('header.openAutomations');
                expect(select).toHaveBeenCalledWith('header.openAutomations');
            }
            const retained = [...new Set(writes.mock.contexts)]
                .filter((cache): cache is LruMap<unknown, unknown> => cache instanceof LruMap)
                .flatMap(cache => [...cache.values()])
                .filter(value => typeof value === 'object' && value !== null
                    && 'rightElement' in value && React.isValidElement(value.rightElement));
            expect(retained).toHaveLength(0);
        } finally {
            writes.mockRestore();
        }
    });

    it('keeps only state on the header: the rail carries destinations, and without a visible rail (i) and ⋯ reach them', () => {
        const session = createSessionFixture({ id: 'header-rail-access' });
        const input = {
            isDataReady: true, session, sessionId: session.id,
            sessionInfoHref: '/session/header-rail-access/info',
            sessionRunsHref: '/session/header-rail-access/runs',
            sessionAutomationsHref: '/session/header-rail-access/automations',
            paneScopeId: 'header-rail-access', windowWidth: 1400,
            sessionAutomationsEnabledCount: 2, sessionExecutionRunsSupported: true,
            showAutomations: true, shouldShowSubagentsButton: true, subagentActiveCount: 1,
            browserMenuEntryAvailable: true,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000', headerTintColor: '#000', statusErrorColor: '#f00',
            externalSessionRuntime: null,
        } satisfies Parameters<typeof resolveSessionViewHeaderProps>[0];
        const types = (value: ReturnType<typeof resolveSessionViewHeaderProps>) => React.Children.toArray(
            (value.rightElement as React.ReactElement<{ children?: React.ReactNode }>).props.children,
        ).filter(React.isValidElement).map((child) => child.type);
        const ids = (value: ReturnType<typeof resolveSessionViewHeaderProps>) => (findHeaderActionMenu(value).props.extraItems ?? [])
            .map((item: { id: string }) => item.id);

        // A visible rail: no (i), no destination glyphs or menu duplicates; Automations stays reachable in ⋯.
        const rail = resolveSessionViewHeaderProps({ ...input, actionRailVisible: true });
        expect(types(rail)).not.toContain(SessionHeaderInfoButton);
        expect(findHeaderActionMenu(rail).props.destinationsInMenu).toBe(false);
        expect(ids(rail)).toEqual(['header.openAutomations']);

        // No visible rail (multi-pane off on a desktop, a phone, no adapter): (i) and every destination in ⋯.
        const noRail = resolveSessionViewHeaderProps({ ...input, actionRailVisible: false });
        expect(findHeaderActionMenu(noRail).props.beforeMenu.type).toBe(SessionHeaderInfoButton);
        expect(findHeaderActionMenu(noRail).props.destinationsInMenu).toBe(true);
        expect(ids(noRail)).toEqual(['header.openSubagents', 'header.openTerminal', 'header.openBrowser', 'header.openAutomations']);
        // A phone reaches Terminal through its own bottom bar.
        expect(ids(resolveSessionViewHeaderProps({ ...input, mobileTerminalTabAvailable: true }))).not.toContain('header.openTerminal');

        // Board is always one menu entry, never a glyph.
        const boardHeaderAction = { onPress: () => {}, preferDirect: true };
        expect(findBoardHeaderButton(resolveSessionViewHeaderProps({ ...input, boardHeaderAction }))).toBeUndefined();
        expect(ids(resolveSessionViewHeaderProps({ ...input, boardHeaderAction }))).toContain('header.openBoard');
    });

    it('drops a subtitle that only repeats the title (an unnamed session titled after its folder)', () => {
        const session = createSessionFixture({ id: 'header-folder-title' });
        const input = {
            isDataReady: true, session, sessionId: session.id,
            sessionInfoHref: '/session/header-folder-title/info',
            sessionRunsHref: '/session/header-folder-title/runs',
            sessionAutomationsHref: '/session/header-folder-title/automations',
            paneScopeId: 'header-folder-title', windowWidth: 1400,
            sessionAutomationsEnabledCount: 0, sessionExecutionRunsSupported: true,
            showAutomations: false, shouldShowSubagentsButton: false, subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000', headerTintColor: '#000', statusErrorColor: '#f00',
            externalSessionRuntime: null,
        } satisfies Parameters<typeof resolveSessionViewHeaderProps>[0];
        const title = resolveSessionViewHeaderProps(input).title;
        expect(title.length).toBeGreaterThan(0);

        expect(resolveSessionViewHeaderProps({ ...input, workspaceSubtitle: title }).subtitle).toBeUndefined();
        expect(resolveSessionViewHeaderProps({ ...input, workspaceSubtitle: `~/code/${title}` }).subtitle).toBe(`~/code/${title}`);
    });

    it('names a Voice conversation by where it lives, never by its private folder', () => {
        const session = createSessionFixture({
            id: 'voice-conversation-header',
            metadata: {
                path: '/home/me/.happier/voice/3f9c2d7a8b1e4f60a5c3d2e1f0b9a8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1',
                homeDir: '/home/me',
                machineId: 'machine-1',
                ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
            } as Session['metadata'],
        });
        const input = {
            isDataReady: true, session, sessionId: session.id,
            sessionInfoHref: '/session/voice-conversation-header/info',
            sessionRunsHref: '/session/voice-conversation-header/runs',
            sessionAutomationsHref: '/session/voice-conversation-header/automations',
            paneScopeId: 'voice-conversation-header', windowWidth: 1400,
            sessionAutomationsEnabledCount: 0, sessionExecutionRunsSupported: true,
            showAutomations: false, shouldShowSubagentsButton: false, subagentActiveCount: 0,
            navigateWithBlurOnWeb: (action: () => void) => action(),
            handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} },
            actionIconColor: '#000', headerTintColor: '#000', statusErrorColor: '#f00',
            externalSessionRuntime: null,
            workspaceSubtitle: '~/.happier/voice/3f9c2d7a8b1e4f60a5c3d2e1f0b9a8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1',
            voiceConversationSubtitle: 'Global Voice · OpenAI Realtime',
        } satisfies Parameters<typeof resolveSessionViewHeaderProps>[0];

        expect(resolveSessionViewHeaderProps(input).subtitle).toBe('Global Voice · OpenAI Realtime');
        // An ordinary session keeps its folder.
        const ordinary = createSessionFixture({ id: 'ordinary-header' });
        expect(resolveSessionViewHeaderProps({ ...input, session: ordinary, sessionId: ordinary.id, workspaceSubtitle: '~/code/app' }).subtitle)
            .toBe('~/code/app');
    });

    it('keeps a deduplicated workspace conflict discoverable from the session header', async () => {
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
        const screen = await renderScreen(<>{conflictButtons[0]}</>);
        try {
            expect(screen.findAll(node => typeof node.type === 'string'
                && node.props.accessibilityRole === 'button'
                && node.props.accessibilityLabel === t('workspaceSync.attention.conflictedLinks', { count: 1 }))).toHaveLength(1);
        } finally {
            await screen.unmount();
        }
        expect(conflictButtons[0].props.accessibilityLabel).toBe(
            t('workspaceSync.attention.conflictedLinks', { count: 1 }),
        );
        conflictButtons[0].props.onPress?.();
        expect(onOpenWorkspaceSyncConflicts).toHaveBeenCalledTimes(1);
    });

    it('keeps plugin header contributions in their order, in overflow', () => {
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
        // Plugin header actions keep their scope and invocation but always live in ⋯ (calm-shell `cshead.H1`).
        expect(oneWide.props.pluginHeaderActionPlacement).toBe('overflow');
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

    it('puts Board, Companion and plugin actions in the one ⋯, with no direct header slot', () => {
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

        expect(findBoardHeaderButton(result)).toBeUndefined();
        expect(menu.props.extraItems).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'header.openBoard', title: t(SESSION_BOARD_DESTINATION.labelKey) }),
        ]));
        expect(menu.props.companionHeaderActionPlacement).toBe('overflow');
        expect(menu.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(menu.props.companionHeaderIntent).toMatchObject({
            operation: 'hide',
            checked: true,
            expanded: true,
        });
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
        } satisfies Parameters<typeof resolveSessionViewHeaderProps>[0];

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

    it('names storage only for an external Session: a Happier Session carries no storage badge', () => {
        // Healthy state is quiet. Every Session in Happier is a Happier Session, so a "Happier"
        // badge says nothing and costs the title its width; only an external Session needs naming.
        const session = createSessionFixture({
            id: 'native-session',
            metadata: { path: '/tmp/project', host: 'test-host' },
        });
        const header = resolveSessionViewHeaderProps({
            isDataReady: true,
            session,
            sessionId: session.id,
            sessionInfoHref: '/session/native-session/info',
            sessionRunsHref: '/session/native-session/runs',
            sessionAutomationsHref: '/session/native-session/automations',
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
        } as const);

        expect(header.badges ?? []).toEqual([]);
    });

    it.each(['codex', null])('uses layout-v1 public Agent presentation %s alongside the private workspace subtitle', (agentId) => {
        const session = createSessionFixture({
            id: 'layout-v1-session',
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                ...(agentId ? { agentPresentation: { agentId } } : {}),
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
            } as never,
            ownerMetadataView: {
                path: '/Users/private/project',
                flavor: 'claude',
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
        expect(result.agentId).toBe(agentId);
        expect(result.flavor).toBe(agentId);
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
