import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';
import {
    buildLocalServiceInventoryState,
    buildManagedLocalServicesState,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    type LocalServiceLaunchTarget,
} from '@/sync/domains/local/services/launch';

import { LocalServicesSurfaceHost } from './LocalServicesSurfaceHost';

const useFeatureDecisionMock = vi.hoisted(() => vi.fn((featureId: FeatureId, _scope?: unknown): FeatureDecision => ({
    featureId,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
})));
const pluginProjectionState = vi.hoisted(() => ({
    appShell: {
        pluginUiProjection: null as unknown,
        machineId: 'machine-global' as string | null,
        serverId: 'server-global' as string | null,
        platform: 'web' as const,
    },
    scoped: {
        pluginUiProjection: null as unknown,
        machineId: 'machine-a' as string | null,
        serverId: 'server-a' as string | null,
        platform: 'web' as const,
    },
    scopedInputs: [] as unknown[],
    stackProps: [] as Record<string, unknown>[],
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId, scope?: unknown) => useFeatureDecisionMock(featureId, scope),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => pluginProjectionState.appShell,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: (params: unknown) => {
        pluginProjectionState.scopedInputs.push(params);
        return pluginProjectionState.scoped;
    },
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementStack: (props: Record<string, unknown>) => {
        pluginProjectionState.stackProps.push(props);
        return React.createElement('PluginSurfacePlacementStackStub', {
            ...props,
            testID: props.testID,
        });
    },
}));

const openableTarget: LocalServiceLaunchTarget = {
    id: 'preview:host-feed',
    source: 'registered_preview',
    machineId: 'machine-a',
    sessionId: 'session-a',
    title: 'Host feed preview',
    subtitle: 'localhost:5173',
    confidence: 'high',
    state: 'available',
    actions: [],
    browserTarget: {
        kind: 'localServicePreview',
        targetId: 'preview-host',
        sessionId: 'session-a',
        machineId: 'machine-a',
    },
};

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [openableTarget],
    });
}

describe('LocalServicesSurfaceHost', () => {
    beforeEach(() => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId): FeatureDecision => ({
            featureId,
            state: 'enabled',
            blockedBy: null,
            blockerCode: 'none',
            diagnostics: [],
            evaluatedAt: 1,
            scope: { scopeKind: 'runtime' },
        }));
        pluginProjectionState.appShell = {
            pluginUiProjection: null,
            machineId: 'machine-global',
            serverId: 'server-global',
            platform: 'web',
        };
        pluginProjectionState.scoped = {
            pluginUiProjection: null,
            machineId: 'machine-a',
            serverId: 'server-a',
            platform: 'web',
        };
        pluginProjectionState.scopedInputs = [];
        pluginProjectionState.stackProps = [];
    });

    it('renders the detected services pane and the Services-bound plugin stack under the testID prefix', async () => {
        const screen = await renderScreen(
            <LocalServicesSurfaceHost
                machineId="machine-a"
                serverId="server-a"
                sessionId="session-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                testID="surface-host-services"
            />,
        );

        expect(screen.findByTestId('surface-host-services-row:preview:host-feed')).toBeTruthy();
        expect(screen.findByTestId('surface-host-services-plugin-stack')).toBeTruthy();
        expect(pluginProjectionState.stackProps.at(-1)).toMatchObject({
            container: 'servicesPanel',
            targetKind: 'services',
        });
    });

    it('threads the explicit sessionId into the pane so this-session grouping uses it (§5.6)', async () => {
        const screen = await renderScreen(
            <LocalServicesSurfaceHost
                machineId="machine-a"
                serverId="server-a"
                sessionId="session-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                testID="surface-host-services"
            />,
        );
        // The session-a preview lands in the This-session band (explicit sessionId threaded host→pane).
        expect(screen.findByTestId('surface-host-services-band-thisSession')).toBeTruthy();
    });

    it('invokes the injected onOpenServiceInBrowser callback with the launch target when the open affordance fires', async () => {
        const onOpenServiceInBrowser = vi.fn();
        const screen = await renderScreen(
            <LocalServicesSurfaceHost
                machineId="machine-a"
                serverId="server-a"
                sessionId="session-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                onOpenServiceInBrowser={onOpenServiceInBrowser}
                testID="surface-host-services"
            />,
        );

        await pressTestInstanceAsync(
            screen.findByTestId('surface-host-services-row:preview:host-feed-open'),
            'surface-host-services-row:preview:host-feed-open',
        );

        expect(onOpenServiceInBrowser).toHaveBeenCalledExactlyOnceWith(openableTarget);
    });

    it('does not render the open affordance when no onOpenServiceInBrowser callback is supplied', async () => {
        const screen = await renderScreen(
            <LocalServicesSurfaceHost
                machineId="machine-a"
                serverId="server-a"
                sessionId="session-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                testID="surface-host-services"
            />,
        );

        expect(screen.findAllByTestId('surface-host-services-row:preview:host-feed-open')).toHaveLength(0);
    });

    it('passes the host-selected Services origin and session to plugin services surfaces', async () => {
        pluginProjectionState.appShell = {
            pluginUiProjection: { generation: 1, surfacePlacementsById: {} },
            machineId: 'machine-global',
            serverId: 'server-global',
            platform: 'web',
        };
        pluginProjectionState.scoped = {
            pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
            machineId: 'machine-a',
            serverId: 'server-a',
            platform: 'web',
        };

        await renderScreen(
            <LocalServicesSurfaceHost
                machineId="machine-a"
                serverId="server-a"
                sessionId="session-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                testID="surface-host-services"
            />,
        );

        const stackProps = pluginProjectionState.stackProps.at(-1);
        expect(stackProps?.pluginUiProjection).toEqual({ generation: 2, surfacePlacementsById: {} });
        expect(stackProps?.machineId).toBe('machine-a');
        expect(stackProps?.serverId).toBe('server-a');
        expect(stackProps?.sessionId).toBe('session-a');
    });

    it('does not substitute a scoped projection machine for a missing Services host origin', async () => {
        pluginProjectionState.scoped = {
            pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
            machineId: 'machine-arbitrary-current',
            serverId: 'server-arbitrary-current',
            platform: 'web',
        };

        await renderScreen(
            <LocalServicesSurfaceHost
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                testID="surface-host-services"
            />,
        );

        const stackProps = pluginProjectionState.stackProps.at(-1);
        expect(stackProps?.machineId).toBeNull();
        expect(stackProps?.serverId).toBeNull();
        expect(stackProps?.sessionId).toBeUndefined();
        expect(stackProps).not.toHaveProperty('runtimeActionExecute');
    });

    it('keeps an admitted unavailable Services projection unavailable instead of self-resolving ambient state', async () => {
        pluginProjectionState.scoped = {
            pluginUiProjection: { generation: 2, surfacePlacementsById: {} },
            machineId: 'machine-ambient',
            serverId: 'server-ambient',
            platform: 'web',
        };

        await renderScreen(
            <LocalServicesSurfaceHost
                machineId="machine-pane-driver"
                serverId="server-pane-driver"
                sessionId="session-a"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={buildLauncherState()}
                pluginUiProjection={null}
                projectionInteractionEnabled={false}
                platform="web"
                testID="surface-host-services"
            />,
        );

        const stackProps = pluginProjectionState.stackProps.at(-1);
        expect(stackProps?.pluginUiProjection).toBeNull();
        expect(stackProps?.projectionInteractionEnabled).toBe(false);
        expect(stackProps?.machineId).toBe('machine-pane-driver');
        expect(stackProps?.serverId).toBe('server-pane-driver');
        expect(pluginProjectionState.scopedInputs).toContainEqual({
            machineId: null,
            serverId: null,
            enabled: false,
        });
    });

    it('is the single fix-point: the three Services views delegate to it instead of re-declaring the wiring', () => {
        const repoRoot = path.resolve(__dirname, '../../../..');
        const viewPaths = [
            'sources/components/sessions/panes/services/SessionRightPanelServicesView.tsx',
            'sources/components/projects/detail/services/ProjectRightPanelServicesView.tsx',
            'sources/components/workspaceCockpit/session/SessionServicesSurfaceScreen.tsx',
        ];

        for (const relPath of viewPaths) {
            const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
            expect(source).toContain('LocalServicesSurfaceHost');
            expect(source).not.toContain('createDefaultRuntimeActionExecutor');
            expect(source).not.toContain('useManagedLocalServicesStateController');
            expect(source).not.toContain('createLocalServiceInventoryState');
        }
    });
});
