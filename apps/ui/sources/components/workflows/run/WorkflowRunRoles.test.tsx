import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRoleSelectionV1, type RoleOverrideV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { WorkflowAcceptedRunRoles, WorkflowRunRoles } from './WorkflowRunRoles';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

const artifactRequests: string[] = [];
installSessionPaneRuntimeTestHarness({ request: async (url) => {
    const path = new URL(String(url)).pathname;
    if (path !== '/v1/artifacts') return null;
    artifactRequests.push(path);
    return Response.json([]);
} });
let disposeExecutorLoader: (() => void) | undefined;
beforeEach(async () => {
    disposeExecutorLoader = await installRealActionExecutorModuleLoader();
    // Account restoration starts the real background Artifact sync. Settle its
    // initial HTTP request before observing reads caused by the role surface.
    await vi.waitFor(() => expect(artifactRequests.length).toBeGreaterThan(0));
    artifactRequests.length = 0;
});
afterEach(() => { disposeExecutorLoader?.(); artifactRequests.length = 0; });
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));

const definition = createWorkflowDefinitionFixture({ defaults: { engine: { role: 'portable_builder' } }, roles: [{
    roleId: 'portable_builder', name: 'Accepted builder', instructions: 'Build carefully', runsAs: { kind: 'session' },
}] });

describe('workflow run role controls', () => {

    it('edits one run-layer field and Use your role removes only that role override', async () => {
        const onChange = vi.fn();
        const other: RoleOverrideV1 = { roleId: 'other_role', secondOpinion: 'encouraged' };
        function Host() {
            const [overrides, setOverrides] = React.useState<readonly RoleOverrideV1[]>([
                { roleId: 'portable_builder', workspaceWrites: 'deny' }, other,
            ]);
            return <WorkflowRunRoles definition={definition} roleIds={['portable_builder']} overrides={overrides}
                pending={false} prefix="run" onChange={(next) => { setOverrides(next); onChange(next); }} />;
        }
        const screen = await renderScreen(<Host />);
        await screen.pressByTestIdAsync('run-role-portable_builder-target:background_run');
        expect(onChange).toHaveBeenLastCalledWith([other, {
            roleId: 'portable_builder', workspaceWrites: 'deny', runsAs: { kind: 'background_run', intent: 'task' },
        }]);
        await screen.pressByTestIdAsync('run-role-portable_builder-reset');
        expect(onChange).toHaveBeenLastCalledWith([other]);
        expect(definition.roles?.[0]?.runsAs).toEqual({ kind: 'session' });
    });

    it('renders frozen role facts without reading today’s mutable role catalog', async () => {
        const acceptedRole = resolveRoleSelectionV1({ roleId: 'portable_builder', workflowRoles: definition.roles });
        if (!acceptedRole.ok) throw new Error('invalid_role_fixture');
        const screen = await renderScreen(<WorkflowAcceptedRunRoles leaves={[{ sourceKey: '$root', blockId: 'analyze', kind: 'step',
            selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' }, role: acceptedRole.selection }]} />);
        expect(screen.getTextContent()).toContain('Accepted builder');
        expect(artifactRequests).toEqual([]);
        expect(screen.findByTestId('run-role-portable_builder-engine')).toBeNull();
    });
});
