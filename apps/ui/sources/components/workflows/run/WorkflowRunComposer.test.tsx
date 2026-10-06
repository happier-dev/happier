import * as React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamSummaryFixture, teamPolicyFixture, teamCapabilitiesFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';

const executeMock = vi.hoisted(() => vi.fn());
const appliedHome = vi.hoisted(() => ({ serverId: 'server-a', serverUrl: 'https://server-a.example' }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => executeMock }));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => appliedHome,
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// The harness installs network leaves before the real UI binds its scoped transport.
const { WorkflowRunComposer } = await import('./WorkflowRunComposer');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { createExecutionRunStartContentChip } = await import('@/components/sessions/runs/launcher/executionRunStartChips');

async function offerTeams(teamIds: readonly string[], required = false) {
    appliedHome.serverUrl = 'https://workflow.example';
    appliedHome.serverId = await home.addHome({ name: 'Workflow Home', serverUrl: 'https://workflow.example', accountId: 'account-a' });
    getStorage().setState({ profileScope: { serverId: appliedHome.serverId, accountId: 'account-a' } });
    home.answer(appliedHome.serverId, '/v1/teams/get', { select: (input) => {
        const teamId = (input as { teamId: string }).teamId;
        return teamIds.includes(teamId) ? { body: teamSummaryFixture({ id: teamId,
            name: teamId === 'team-a' ? 'Builders' : 'Reviewers', viewerRole: 'member', capabilities: teamCapabilitiesFixture({}),
            policy: teamPolicyFixture({ sessionCreationPolicy: required ? 'team_required' : 'team_default' }) }) }
            : { status: 404, body: { error: 'team_not_found' } };
    } });
}
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
    let restorePopoverGlobals: (() => void) | undefined;
    beforeEach(async () => {
        resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests();
        await home.reset();
        appliedHome.serverId = 'server-a';
        appliedHome.serverUrl = 'https://server-a.example';
        restorePopoverGlobals = withPopoverWebGlobals();
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
        executeMock.mockReset();
    });
    afterEach(() => { standardCleanup(); restorePopoverGlobals?.(); });
    it('renders and opens a custom Where control in the wrapped composer', async () => {
        const where = { ...createExecutionRunStartContentChip({ key: 'review-where', icon: 'folder',
            label: 'Builder · /repo', title: 'Where', testID: 'review-where-chip',
            renderContent: <View testID="review-where-content" />,
        }), controlId: 'machine' as const };
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} extraActionChips={[where]} />);
        expect(screen.findByTestId('review-where-chip')).not.toBeNull();
        await screen.pressByTestIdAsync('review-where-chip');
        expect(screen.findByTestId('review-where-content')).not.toBeNull();
    });
    it.each([['team-a'], ['team-a', 'team-b']])('reviews only granted Teams before admitting the draft (%j)', async (...teamIds) => {
        await offerTeams(teamIds);
        executeMock.mockImplementation(async (action: string) => action === 'artifact.access.grants.list'
            ? { ok: true, result: { artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner',
                grants: [
                    ...teamIds.map(teamId => ({ principal: { kind: 'team', teamId }, accessLevel: 'edit',
                        createdByAccountId: 'account-a', createdAt: 1, display: { name: teamId === 'team-a' ? 'Builders' : 'Reviewers' } })),
                    { principal: { kind: 'account', accountId: 'friend' }, accessLevel: 'view',
                        createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Friend' } },
                ] } }
            : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [] })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-visibility-chip')).not.toBeNull());
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(teamIds.length > 1);
        if (teamIds.length > 1) {
            await screen.pressByTestIdAsync('workflow-run-inputs-visibility-chip');
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            const select = screen.root.findByType(DropdownMenu);
            expect(select.props.items.map((item: { id: string }) => item.id)).toEqual(teamIds);
            const { act } = await import('react-test-renderer');
            await act(async () => select.props.onSelect('team-b'));
        }
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, [], teamIds.at(-1));
    });
    it('discloses member editing before a team_required start', async () => {
        await offerTeams(['team-a'], true);
        executeMock.mockResolvedValue({ ok: true, result: { artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner',
            grants: [{ principal: { kind: 'team', teamId: 'team-a' }, accessLevel: 'edit',
                createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Builders' } }] } });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [] })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        expect(screen.findByTestId('workflow-run-inputs-team-required')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, [], 'team-a');
    });
    it('excludes an unreadable Team even when the caller can use its Artifact', async () => {
        await offerTeams(['team-a']);
        executeMock.mockResolvedValue({ ok: true, result: { artifactId: 'saved-workflow', ownerAccountId: 'someone-else', access: 'view',
            grants: ['team-a', 'team-hidden'].map(teamId => ({ principal: { kind: 'team', teamId }, accessLevel: 'view',
                createdByAccountId: 'someone-else', createdAt: 1, display: { name: teamId } })) } });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [] })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        expect(screen.findByTestId('workflow-run-inputs-team-required')).toBeNull();
        await screen.pressByTestIdAsync('workflow-run-inputs-visibility-chip');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        expect(screen.root.findAllByType(DropdownMenu)).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, [], 'team-a');
        expect(home.requests.filter(request => request.path === '/v1/teams/get').map(request => request.input)).toEqual(
            expect.arrayContaining([{ v: 1, teamId: 'team-a' }, { v: 1, teamId: 'team-hidden' }]));
    });
    it('keeps Start closed when grant discovery fails and retries without assuming private visibility', async () => {
        executeMock.mockResolvedValue({ ok: false, errorCode: 'artifact_access_unavailable', error: 'artifact_access_unavailable' });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [] })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).not.toHaveBeenCalled();
        executeMock.mockResolvedValue({ ok: true, result: { artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner', grants: [] } });
        await screen.pressByTestIdAsync('workflow-run-inputs-visibility-retry');
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, []);
    });
    it('discards a late grant read when the reviewed source changes to an unbound inline draft', async () => {
        let resolveGrants!: (value: unknown) => void;
        executeMock.mockImplementation(async () => new Promise((resolve) => { resolveGrants = resolve; }));
        let changeSource!: (source: string | null) => void;
        const onRun = vi.fn();
        function Host() {
            const [source, setSource] = React.useState<string | null>('saved-workflow');
            changeSource = setSource;
            return <WorkflowRunComposer sourceArtifactId={source} definition={createWorkflowDefinitionFixture({ inputs: [] })}
                inputs={[]} values={{}} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />;
        }
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        const { act } = await import('react-test-renderer');
        await act(async () => { changeSource(null); });
        await act(async () => { resolveGrants({ ok: true, result: { artifactId: 'saved-workflow', ownerAccountId: 'account-a',
            access: 'owner', grants: [{ principal: { kind: 'team', teamId: 'team-old' }, accessLevel: 'edit',
                createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Old Team' } }] } }); });
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
        expect(screen.findByTestId('workflow-run-inputs-visibility-chip')).toBeNull();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, []);
    });
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
            return action === 'artifact.access.grants.list'
                ? { ok: true, result: { artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner', grants: [] } }
                : { ok: true, result: { items: [] } };
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

    it('keeps a refused Start in the composer with its reason and Start available to retry', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}} onRun={() => {}}
            onCancel={() => {}} startProblem="workflows.problem.targetUnavailable" />);
        expect(screen.findByTestId('workflow-run-inputs-reason')?.props.accessibilityRole).toBe('alert');
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.problem.targetUnavailable');
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });

    it('keeps a no-text workflow inspectable without a dead editable input', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });
});
