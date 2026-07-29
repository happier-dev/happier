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
    stackProps: [] as Record<string, unknown>[],
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId, scope?: unknown) => useFeatureDecisionMock(featureId, scope),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => pluginProjectionState.appShell,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => pluginProjectionState.scoped,
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
        pluginProjectionState.stackProps = [];
    });

    it('renders the detected services pane and the services.panel plugin stack under the testID prefix', async () => {
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

    it('passes the scoped services machine projection into plugin services surfaces', async () => {
        pluginProjectionState.appShell = {
            pluginUiProjection: { generation: 1, surfacePlacementsByPlacement: {} },
            machineId: 'machine-global',
            serverId: 'server-global',
            platform: 'web',
        };
        pluginProjectionState.scoped = {
            pluginUiProjection: { generation: 2, surfacePlacementsByPlacement: {} },
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
        expect(stackProps?.pluginUiProjection).toEqual({ generation: 2, surfacePlacementsByPlacement: {} });
        expect(stackProps?.machineId).toBe('machine-a');
        expect(stackProps?.serverId).toBe('server-a');
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
