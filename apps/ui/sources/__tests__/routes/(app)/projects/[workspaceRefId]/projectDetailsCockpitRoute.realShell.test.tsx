import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSessionRouteCommonModuleMocks } from '../../session/[id]/sessionRouteTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = createExpoRouterMock({
    params: { workspaceRefId: 'wr_1' }, navigation: { canGoBack: () => true },
});
installSessionRouteCommonModuleMocks({
    router: () => router.module,
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_1' });
beforeEach(() => {
    storage.getState().applySettingsLocal({
        mobileWorkspaceExperienceV1: 'cockpit',
        workspaceRefsV1: [WorkspaceRefV1Schema.parse({
            id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1',
            rootPath: '/repo', label: 'Project Alpha', createdAtMs: 1,
        })],
    });
    storage.getState().applyMachines([createMachineFixture({ storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
});

describe('project details route in cockpit mode with the real shell', () => {
    it('renders the actual details surface when a canonical file tab is already open', async () => {
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/details')).default;
        const { ProjectDetailsMainPanel } = await import('@/components/projects/detail/ProjectDetailsMainPanel');
        const { createProjectFileDetailsTab } = await import('@/components/projects/detail/projectDetailsTabBuilders');
        const tab = createProjectFileDetailsTab('/repo/a.ts');
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => {
            runtime.pane.openRight({ tabId: 'git' });
            runtime.pane.openDetailsTab(tab, { intent: 'pinned' });
        });
        await screen.update(<runtime.Wrapper><Screen /></runtime.Wrapper>);

        expect(screen.findByType(ProjectDetailsMainPanel).props.forceOverviewMode).toBe(false);
        expect(runtime.pane.scopeState.details).toMatchObject({
            isOpen: true, activeTabKey: tab.key, tabs: [expect.objectContaining({ key: tab.key, resource: { kind: 'file', path: '/repo/a.ts' } })],
        });
    });
});
