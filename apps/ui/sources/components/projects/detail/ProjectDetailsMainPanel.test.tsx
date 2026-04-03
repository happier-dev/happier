import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
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

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

const workspaceDetailsPanelSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/projects/panes/WorkspaceDetailsPanel', () => ({
    WorkspaceDetailsPanel: (props: any) => {
        workspaceDetailsPanelSpy(props);
        return React.createElement('WorkspaceDetailsPanelStub', props);
    },
}));

describe('ProjectDetailsMainPanel', () => {
    it('renders WorkspaceDetailsPanel for the project workspace', async () => {
        workspaceDetailsPanelSpy.mockClear();
        const { ProjectDetailsMainPanel } = await import('./ProjectDetailsMainPanel');

        await renderScreen(
            <ProjectDetailsMainPanel
                scopeId="project:wr_1"
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                } as any}
            />,
        );

        expect(workspaceDetailsPanelSpy).toHaveBeenCalledTimes(1);
        expect(workspaceDetailsPanelSpy).toHaveBeenCalledWith(expect.objectContaining({
            scopeId: 'project:wr_1',
            workspaceRef: expect.objectContaining({
                id: 'wr_1',
                serverId: 's1',
                machineId: 'm1',
                rootPath: '/repo',
            }),
        }));
    });
});
