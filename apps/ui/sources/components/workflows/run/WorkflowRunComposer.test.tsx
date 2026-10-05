import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { WorkflowRunComposer } from './WorkflowRunComposer';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol';

const executeMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => executeMock }));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: 'server-a' }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const inputs: readonly WorkflowInputDefinition[] = [
    { name: 'brief', valueType: 'string', required: true },
    { name: 'version', valueType: 'number', required: true },
    { name: 'announce', valueType: 'boolean', required: false, default: true },
];

async function mount(initial: React.ComponentProps<typeof WorkflowRunComposer>['values'] = {}) {
    const onRun = vi.fn();
    function Host() {
        const [values, onChangeValues] = React.useState(initial);
        return <WorkflowRunComposer inputs={inputs} values={values} onChangeValues={onChangeValues} onRun={onRun} onCancel={() => {}} />;
    }
    return { screen: await renderScreen(<Host />), onRun };
}

describe('workflow composer admission', () => {
    it('submits an accepted repeat with frozen root roles and nested step targets', async () => {
        const role = resolveRoleSelectionV1({ roleId: 'builder', runOverrides: [{ roleId: 'builder', workspaceWrites: 'deny' }] });
        if (!role.ok) throw new Error('invalid_role_fixture');
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}}
            definition={createWorkflowDefinitionFixture()} onRun={onRun} onCancel={() => {}} materializedLeaves={[{
                sourceKey: '$root', blockId: 'build', kind: 'step', selection: {}, role: role.selection,
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' },
            }, {
                sourceKey: 'saved-child', blockId: 'child-step', kind: 'step', selection: {},
                authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' },
            }]} />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(screen.findByTestId('workflow-run-inputs-roles-chip')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-targets-chip')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, []);
    });
    it('prefills only the starter’s newest accepted run of the saved workflow', async () => {
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
        const roleOverrides = [{ roleId: 'builder', workspaceWrites: 'deny' as const }];
        const definition = createWorkflowDefinitionFixture({ defaults: { engine: { role: 'builder' } } });
        executeMock.mockImplementation(async (action: string) => {
            if (action === 'workflow.run.list') return { ok: true, result: { metadataByRunId: {}, runs: [
                createWorkflowRunSummaryFixture({ id: 'teammate', ownerAccountId: 'teammate', sourceArtifactId: 'saved-workflow' }),
                createWorkflowRunSummaryFixture({ id: 'own-run', ownerAccountId: 'account-a', sourceArtifactId: 'saved-workflow' }),
            ] } };
            if (action === 'workflow.run.get') return { ok: true, result: {
                callerAccess: { canEdit: true },
                run: createWorkflowRunSummaryFixture({ id: 'own-run', ownerAccountId: 'account-a', sourceArtifactId: 'saved-workflow' }),
                definition, authoredDefinition: definition, acceptedContext: { startedBy: 'user', source: { kind: 'saved', definitionId: 'saved-workflow', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
                    inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' }, materializedLeaves: [], frozenChildren: {}, roleOverrides,
                    workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct' } }, checkpoint: null,
            } };
            return { ok: true, result: { items: [] } };
        });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer definition={definition} sourceArtifactId="saved-workflow"
            inputs={[]} values={{}} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, roleOverrides);
        expect(executeMock.mock.calls.filter(([action]) => action === 'workflow.run.get')[0]?.[1]).toEqual({ runId: 'own-run' });
    });
    it('shows accepted step targets read-only and repeats the accepted role overrides', async () => {
        const definition = createWorkflowDefinitionFixture();
        const roleOverrides = [{ roleId: 'builder', workspaceWrites: 'deny' as const }];
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} definition={definition}
            roleOverrides={roleOverrides} materializedLeaves={[{ sourceKey: '$root', blockId: 'build', kind: 'step',
                selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' } }]} />);
        expect(screen.findByTestId('workflow-run-inputs-targets-chip')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, roleOverrides);
    });
    it('offers Roles for this run for workflows that use a role', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: { engine: { role: 'builder' } } });
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} definition={definition} />);
        expect(screen.findByTestId('workflow-run-inputs-roles-chip')).not.toBeNull();
    });
    it('keeps the needed-inputs chip visible when the missing field is the sole main text input', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'brief', valueType: 'string', required: true }]}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-inputs-chip')).not.toBeNull();
    });
    it('projects the first text input into the composer and other inputs into its chip', async () => {
        const { screen } = await mount({ brief: 'Release the current draft' });
        expect(screen.findByTestId('workflow-run-inputs-main')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-inputs-chip')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
    });

    it('submits validated supplied inputs and defaults through the start callback', async () => {
        const { screen, onRun } = await mount({ brief: 'Keep exact whitespace  ', version: 3 });
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith({ brief: 'Keep exact whitespace  ', version: 3, announce: true });
    });

    it('does not admit missing required input even if the Start handler is invoked', async () => {
        const { screen, onRun } = await mount({ brief: 'Release' });
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-run-inputs-reason')).not.toBeNull();
    });

    it('keeps a no-text workflow inspectable without a dead editable input', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });
});
