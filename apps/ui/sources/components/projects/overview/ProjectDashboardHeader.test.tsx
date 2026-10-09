import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetInstanceActionOutputSchemasV1 } from '@happier-dev/protocol/widgets';
import { renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ProjectDashboardHeader } from './ProjectDashboardHeader';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
let unknownDelete = false;
const deletes: string[] = [];
const selected: (string | null)[] = [];
const runtime = installSessionPaneRuntimeTestHarness({ request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'widgets.area.dashboard.delete': ['ui'] } },
    } }, version: 1 });
    if (init?.method === 'DELETE' && path.startsWith('/v1/artifacts/')) {
        deletes.push(path);
        if (unknownDelete) throw new TypeError('The Home lost the deletion acknowledgement');
    }
    return artifacts.handle(path, init);
} });
let disposeActionLoader: (() => void) | undefined;
beforeAll(async () => { disposeActionLoader = await installRealActionExecutorModuleLoader(); });
afterAll(() => disposeActionLoader?.());
beforeEach(() => { artifacts.clear(); unknownDelete = false; deletes.length = 0; selected.length = 0; });

async function renderReleaseSelected() {
    const surface = { serverId: runtime.serverId, accountId: 'account-a', owner: { kind: 'project' as const, projectId: 'project-key' } };
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('widgets.area.dashboard.create', {
        surface, dashboardId: 'release', name: 'Release',
    }, { surface: 'ui', serverId: runtime.serverId, expectedAccountId: 'account-a' });
    if (!result.ok) throw new Error(`Dashboard fixture refused: ${JSON.stringify(result)}`);
    const dashboard = WidgetInstanceActionOutputSchemasV1['widgets.area.dashboard.create'].parse(result.result);
    const screen = await renderScreen(<runtime.Wrapper><ProjectDashboardHeader
        workspaceRef={{ id: 'w1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1, projectKey: 'project-key' }}
        activeRootPath="/repo" projectName="happier" dashboardId="release" onSelectDashboard={id => selected.push(id)}
    /></runtime.Wrapper>);
    const actions = () => screen.findAllByType(DropdownMenu).find(node =>
        node.props.items.some((item: { id: string; disabled?: boolean }) => item.id === 'delete' && item.disabled !== true));
    await vi.waitFor(() => expect(actions()).toBeTruthy());
    return { screen, dashboard, actions: actions()! };
}

describe('ProjectDashboardHeader', () => {
    it('deletes the exact selected dashboard at its revision, then selects the default Overview', async () => {
        const { dashboard, actions } = await renderReleaseSelected();
        await act(async () => { actions.props.onSelect('delete'); });
        await vi.waitFor(() => expect(selected).toEqual([null]));
        expect(deletes).toEqual([`/v1/artifacts/${dashboard.artifactId}/revision/${dashboard.revision?.headerVersion}/${dashboard.revision?.bodyVersion}`]);
        expect(artifacts.read(dashboard.artifactId)).toBeNull();
    });

    it('keeps the dashboard selected and says so when the delete outcome is unknown', async () => {
        const { screen, dashboard, actions } = await renderReleaseSelected();
        unknownDelete = true;
        await act(async () => { actions.props.onSelect('delete'); });
        await vi.waitFor(() => expect(screen.findByTestId('project-dashboards.deleteUnknown')).toBeTruthy());
        expect(selected).toEqual([]);
        expect(artifacts.read(dashboard.artifactId)).not.toBeNull();
        expect(deletes).toHaveLength(1);
    });
});
