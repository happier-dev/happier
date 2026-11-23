import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import type { DetailsSplitWorkspaceProps } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { createBrowserLaunchpadDetailsTab } from '@/components/browser/surfaces/browserSurfaceDetailsTabModel';
import { act } from 'react-test-renderer';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { WorkspaceSyncRelationshipList } from '@/components/workspaces/sync/WorkspaceSyncRelationshipList';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

installPanelCommonModuleMocks();
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

// Prepare the real module outside the route assertion's interaction budget.
const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');

afterEach(standardCleanup);

describe('workspace Details tab destinations', () => {
    it('opens the selected guest endpoint when both Sync endpoints share the controller and path', async () => {
        const base = { v: 2, kind: 'managed', serverId: 'home-test',
            controller: { machineId: 'machine-test', installationId: 'install-1' }, rootPath: '/repo', createdAtMs: 1 } as const;
        const alpha = { ...base, id: 'alpha', managedId: 'guest-a' };
        const beta = { ...base, id: 'beta', managedId: 'guest-b' };
        const endpoint = (ref: typeof beta) => ({ workspaceRefId: ref.id, workspaceRef: ref, name: ref.id, label: ref.id, machineName: null });
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'link', controllerMachineId: 'machine-test',
            alphaWorkspaceRefId: alpha.id, betaWorkspaceRefId: beta.id, mode: 'keep_synced', enabled: false,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 });
        const scopeId = 'project:beta';
        let pane!: ReturnType<typeof useAppPaneScope>;
        function ObservePane() { pane = useAppPaneScope(scopeId); return null; }
        const screen = await renderScreen(<AppPaneProvider>
            <ObservePane />
            <WorkspaceDetailsPanel workspaceRef={beta} scopeId={scopeId}
                destinationTab={{ key: 'workspace-info', kind: 'workspaceInfo', title: 'Workspace', isPinned: true, isPreview: false }} />
        </AppPaneProvider>);
        const list = screen.findByType(WorkspaceSyncRelationshipList);
        await act(async () => list.props.onOpenDetails?.({ serverId: base.serverId, relationship, relationshipId: 'link',
            alpha: endpoint(alpha), beta: endpoint(beta), status: null }));
        expect(pane.scopeState?.details.tabs).toContainEqual(expect.objectContaining({
            resource: expect.objectContaining({ kind: 'workspaceSyncConflicts', workspaceRefId: beta.id }),
        }));
    });

    it('keeps tabs without a shareable route local while preserving scoped file destinations', async () => {
        const screen = await renderScreen(<AppPaneProvider><WorkspaceDetailsPanel
            workspaceRef={{ id: 'workspace-tab-href', serverId: 'home-test', machineId: 'machine-test', rootPath: '/repo', createdAtMs: 1 }}
            scopeId="project:workspace-tab-href"
        /></AppPaneProvider>);
        const { resolveTabHref } = screen.find(node => typeof node.props.resolveTabHref === 'function').props as DetailsSplitWorkspaceProps;
        if (!resolveTabHref) throw new Error('Expected workspace Details route owner');
        const localTab: DetailsTabState = { ...createBrowserLaunchpadDetailsTab(), isPinned: false, isPreview: false };
        expect(resolveTabHref(localTab)).toBeNull();
        const fileTab: DetailsTabState = { key: 'file:src/app.ts', kind: 'file', title: 'app.ts', resource: { kind: 'file', path: 'src/app.ts' }, isPinned: false, isPreview: false };
        const href = resolveTabHref(fileTab);
        if (!href) throw new Error('Expected shareable file destination');
        const url = new URL(href, 'https://happier.test');
        expect(url.pathname).toBe('/projects/workspace-tab-href/code');
        expect(url.searchParams.get('initialFile')).toBe('src/app.ts');
    });
});
