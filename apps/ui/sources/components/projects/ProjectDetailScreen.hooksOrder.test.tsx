import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import type { Settings } from '@/sync/domains/settings/settings';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let workspaceRefsV1: WorkspaceRefV1[] = [];
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

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: false, activeTabId: null } },
        openRight: () => undefined,
        closeRight: () => undefined,
        setRightTab: () => undefined,
    }),
}));

vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));

vi.mock('./detail/ProjectRightPanel', () => ({
    ProjectRightPanel: () => React.createElement('ProjectRightPanelStub'),
}));

vi.mock('./detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: () => React.createElement('ProjectDetailsMainPanelStub'),
}));

describe('ProjectDetailScreen', () => {
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
