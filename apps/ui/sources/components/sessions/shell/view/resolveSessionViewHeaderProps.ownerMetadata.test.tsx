import * as React from 'react';
import { describe, expect, it } from 'vitest';
import type { PluginProjectionV2 } from '@happier-dev/protocol';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

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

function createPluginHeaderProjection() {
    return normalizePluginUiProjection({
        v: 2,
        generation: 7,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {
            'acme.preview/run': {
                id: 'run',
                pluginId: 'acme.preview',
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
        backendsById: {},
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

        expect(wide.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(narrow.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(oneWide.props.pluginHeaderActionPlacement).toBe('direct');
        expect(oneNarrow.props.pluginHeaderActionPlacement).toBe('overflow');
        expect(wide.props.pluginHeaderActions).toEqual(
            expect.arrayContaining(Array.from({ length: 12 }, (_value, index) => expect.objectContaining({
                action: expect.objectContaining({
                    descriptorId: `action-${index + 1}`,
                    action: expect.objectContaining({ kind: 'executeAction' }),
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
                    agentId,
                    path: '/tmp/project',
                    host: 'test-host',
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
