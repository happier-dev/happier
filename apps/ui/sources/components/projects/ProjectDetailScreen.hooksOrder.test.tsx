import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import type { Settings } from '@/sync/domains/settings/settings';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let workspaceRefsV1: WorkspaceRefV1[] = [];
const projectPaneOpenSurfaceSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));
const settingListeners = new Set<() => void>();
function notifySettingsChanged() {
    for (const listener of settingListeners) {
        listener();
    }
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: keyof Settings) => {
            if (key !== 'workspaceRefsV1') return undefined;
            return React.useSyncExternalStore(
                (listener) => {
                    settingListeners.add(listener);
                    return () => {
                        settingListeners.delete(listener);
                    };
                },
                () => workspaceRefsV1,
                () => workspaceRefsV1,
            ) as Settings[typeof key];
        },
        useLocalSetting: (key: string) => {
            if (key !== 'uiMultiPanePanelsEnabled') return undefined;
            return React.useSyncExternalStore(
                (listener) => {
                    settingListeners.add(listener);
                    return () => {
                        settingListeners.delete(listener);
                    };
                },
                () => true,
                () => true,
            );
        },
    });
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 's1' }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: { generation: 9 },
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: 'm1',
        serverId: 's1',
        platform: 'web',
    }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: false, activeTabId: null } },
        openRight: () => undefined,
        closeRight: () => undefined,
        setRightTab: () => undefined,
    }),
}));

vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => {
        React.useEffect(() => {
            props.onPluginSurfaceOpenChange?.(projectPaneOpenSurfaceSpy);
            return () => props.onPluginSurfaceOpenChange?.(undefined);
        }, [props.onPluginSurfaceOpenChange]);
        return React.createElement('AppPaneScopeHost', props, props.main ?? null);
    },
}));

vi.mock('./detail/ProjectRightPanel', () => ({
    ProjectRightPanel: () => React.createElement('ProjectRightPanelStub'),
}));

vi.mock('./detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: () => React.createElement('ProjectDetailsMainPanelStub'),
}));

describe('ProjectDetailScreen', () => {
    it('forwards the fresh Project AppPane owner through the incumbent shell callback', async () => {
        workspaceRefsV1 = [{
            id: 'wr_1',
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
            label: null,
            createdAtMs: 0,
            lastOpenedAtMs: null,
        }];
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');
        let currentOwner: PluginSurfaceOpenHandler | undefined;
        const onPluginSurfaceOpenChange = vi.fn((next: PluginSurfaceOpenHandler | undefined) => {
            currentOwner = next;
        });
        // Test the public shell callback before its prop is added to the
        // component's declared contract; the mock only models the real host's
        // callback boundary and does not recreate its navigation logic.
        const ProjectDetailScreenWithFreshEntry = ProjectDetailScreen as React.ComponentType<{
            workspaceRefId: string;
            onPluginSurfaceOpenChange?: (next: PluginSurfaceOpenHandler | undefined) => void;
        }>;

        const screen = await renderScreen(
            <ProjectDetailScreenWithFreshEntry
                workspaceRefId="wr_1"
                onPluginSurfaceOpenChange={onPluginSurfaceOpenChange}
            />,
        );
        await act(async () => {});

        expect(screen.tree.findByType('AppPaneScopeHost' as never).props.onPluginSurfaceOpenChange)
            .toBe(onPluginSurfaceOpenChange);
        expect(currentOwner).toBe(projectPaneOpenSurfaceSpy);
    });

    it('supplies the direct Project AppPane adapter with its one scoped projection/currentness fact set', async () => {
        workspaceRefsV1 = [{
            id: 'wr_1',
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
            label: null,
            createdAtMs: 0,
            lastOpenedAtMs: null,
        }];
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);

        expect(screen.tree.findByType('AppPaneScopeHost' as never).props.surfaceScope).toEqual({
            targetKind: 'project',
            projectId: 'wr_1',
            machineId: 'm1',
            serverId: 's1',
            pluginUiProjection: { generation: 9 },
            projectionPhase: 'current',
            interactionEnabled: true,
            platform: 'web',
        });
    });

    it('does not change hook ordering when the workspace ref becomes available after initial render', async () => {
        workspaceRefsV1 = [];
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        await renderScreen(
            <ProjectDetailScreen workspaceRefId="wr_1" />,
        );

        workspaceRefsV1 = [{
            id: 'wr_1',
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
            label: null,
            createdAtMs: 0,
            lastOpenedAtMs: null,
        }];

        let error: unknown = null;
        try {
            await act(async () => {
                notifySettingsChanged();
            });
        } catch (err) {
            error = err;
        }
        expect(error).toBe(null);
    });
});
