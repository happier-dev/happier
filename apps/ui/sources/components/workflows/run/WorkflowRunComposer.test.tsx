import * as React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { t } from '@/text';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { teamSummaryFixture, teamPolicyFixture, teamCapabilitiesFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { PromptLibraryRowsListResponseV1Schema, sealPromptLibraryContentV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, WorkflowRunRecipientCensusResponseV1Schema, materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const appliedHome = vi.hoisted(() => ({ serverId: 'server-a', serverUrl: 'https://server-a.example' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Radix is the native DOM boundary; the real modal lifecycle and composer remain mounted.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
// The harness installs network leaves before the real UI binds its scoped transport.
const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { useWorkflowRunComposerModal } = await import('./useWorkflowRunComposerModal');
const { WorkflowRunComposer } = await import('./WorkflowRunComposer');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { createExecutionRunStartContentChip } = await import('@/components/sessions/runs/launcher/executionRunStartChips');

async function offerTeams(teamIds: readonly string[], required = false) {
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
    return createTextModuleMock({ translate: (key, params) => key.startsWith('machineRequester.') && params
        ? `${key}:${JSON.stringify(params)}` : key });
});

const inputs: readonly WorkflowInputDefinition[] = [
    { name: 'brief', valueType: 'string', required: true },
    { name: 'version', valueType: 'number', required: true },
    { name: 'announce', valueType: 'boolean', required: false, default: true },
];
const STARTABLE_DEFAULTS = { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } as const;

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
    let disposeLoader: (() => void) | undefined;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let previousState = getStorage().getState();
    beforeEach(async () => {
        previousState = getStorage().getState();
        resetTeamsDirectoryEngineForTests(); resetTeamsSnapshotsForTests();
        await home.reset();
        disposeLoader = await installRealActionExecutorModuleLoader();
        appliedHome.serverUrl = `https://workflow-composer-${crypto.randomUUID()}.test`;
        appliedHome.serverId = await home.addHome({ name: 'Workflow Home', serverUrl: appliedHome.serverUrl, accountId: 'account-a', currentAccount: true });
        // Grant reads reopen their Artifact through the real sync codec before disclosure.
        await home.artifacts(appliedHome.serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'saved-workflow', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: 'saved-workflow',
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved workflow' }, previewSteps: [] }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1',
                definition: createWorkflowDefinitionFixture({ defaults: STARTABLE_DEFAULTS }) }) }),
        }) });
        home.answer(appliedHome.serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        home.answer(appliedHome.serverId, '/v1/account/entity-rows/prompt-library', { body: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed',
            rows: [{ key: 'role-overrides', revision: 1, content: sealPromptLibraryContentV1({
                record: { key: 'role-overrides', value: { v: 1, overrides: {} } }, mode: 'plain', material: null,
            }) }],
        }) });
        restorePopoverGlobals = withPopoverWebGlobals();
        connection = await restoreServerAccountForTest({ serverUrl: appliedHome.serverUrl, accountId: 'account-a',
            credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) }, request: home.request });
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
        publishAppliedActiveServerRuntimeAvailability(false);
        restorePopoverGlobals?.();
        await home.reset();
        disposeLoader?.();
        disposeLoader = undefined;
        getStorage().setState(previousState);
    });
    it.each([false, true])('discloses the selected Machine owner and removes the own-machines footer only for a guest (H1 shared=%s)', async shared => {
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { AccessibleMachineAccessV1Schema } = await import('@happier-dev/protocol/machines/machineAccessV1');
        const machine = createMachineFixture({ access: AccessibleMachineAccessV1Schema.parse({
            custodian: { accountId: shared ? 'machine-owner' : 'account-a', displayName: 'Machine owner' },
            role: 'use', resourceMode: 'plain', accessState: 'ready',
        }) });
        getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [appliedHome.serverId]: [machine] } });
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { body: ArtifactAccessGrantsListResponseV1Schema.parse({
            artifactId: 'saved-workflow', ownerAccountId: 'workflow-owner', access: 'edit', grants: [],
        }) });
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow" machineId={machine.id}
            serverId={appliedHome.serverId} definition={createWorkflowDefinitionFixture({ inputs: [], defaults: STARTABLE_DEFAULTS })}
            inputs={[]} values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        if (shared) {
            expect(screen.getTextContent()).toContain(t('machineRequester.runsOn', { owner: 'Machine owner', machine: 'tester.local' }));
            expect(screen.getTextContent()).toContain(t('machineRequester.fullSignIn', { machine: 'tester.local', retention: 'run' }));
            expect(screen.getTextContent()).toContain(t('machineRequester.osVisibility', { owner: 'Machine owner', machine: 'tester.local' }));
            expect(screen.findByTestId('workflow-run-inputs-own-machines')).toBeNull();
        } else {
            expect(screen.getTextContent()).not.toContain('machineRequester.runsOn');
            expect(screen.findByTestId('workflow-run-inputs-own-machines')).not.toBeNull();
        }
    });

    it.each([undefined, { serverId: 'other-home', sessionId: 'explicit-review-session' }])(
        'binds origin Session input defaults without replacing an explicit target (%j)', async (explicit) => {
            const originSession = { serverId: appliedHome.serverId, sessionId: 'origin-session' };
            const onRun = vi.fn();
            const reviewInputs: readonly WorkflowInputDefinition[] = [{ name: 'reviewSession', valueType: 'json', required: true,
                inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }];
            const screen = await renderScreen(<WorkflowRunComposer inputs={reviewInputs} originSession={originSession}
                values={explicit ? { reviewSession: explicit } : {}} onChangeValues={() => {}}
                onRun={onRun} onCancel={() => {}} />);
            expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('workflow-run-inputs-run');
            expect(onRun).toHaveBeenCalledWith({ reviewSession: explicit ?? originSession });
        });
    it('requires an explicit Session when an origin default has no Session context', async () => {
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'reviewSession', valueType: 'json', required: true,
            inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }]}
            values={{}} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).not.toHaveBeenCalled();
    });
    it('offers the participant picker on demand and reads a chosen Session by name, not as JSON', async () => {
        const participant = { kind: 'session', session: { serverId: appliedHome.serverId, sessionId: 'reviewer-session' } } as const;
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'reviewer', valueType: 'json', required: true,
            inputType: { hostType: 'agentParticipant' } }, { name: 'brief', valueType: 'string', required: true }]}
            serverId={appliedHome.serverId} values={{ reviewer: participant }} onChangeValues={() => {}} onRun={vi.fn()} onCancel={() => {}} />);
        // Closed, the start form mounts no participant control (no listing or machine reads).
        expect(screen.findAllByTestId('workflow-run-inputs-reviewer-picker')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-run-inputs-inputs-chip');
        const pickers = screen.findAllByTestId('workflow-run-inputs-reviewer-picker');
        expect(pickers.length).toBeGreaterThan(0);
        expect(pickers.some((node) => node.props.reading === 'session.collaboration.discussion.participants.session')).toBe(true);
        expect(screen.findAllByTestId('workflow-run-inputs-reviewer').some((node) => typeof node.props.value === 'string'
            && node.props.value.includes('reviewer-session'))).toBe(false);
    });
    it('reads a built-in\'s inputs in its own words wherever the form opens, without each caller passing them', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'focus', valueType: 'string', required: false, default: 'Review it' },
            { name: 'maxRounds', valueType: 'number', required: false, default: 3 }]}
            optionsConsumer={{ kind: 'workflow', workflow: 'builtin:review-and-converge' }}
            values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} />);
        await screen.pressByTestIdAsync('workflow-run-inputs-inputs-chip');
        expect(screen.getTextContent()).toContain(t('workflows.builtins.reviewAndConverge.rounds'));
    });
    it('renders and opens a custom Where control in the wrapped composer', async () => {
        const where = { ...createExecutionRunStartContentChip({ key: 'review-where', controlId: 'machine', pending: true, icon: 'folder',
            label: 'Builder · /repo', title: 'Where', testID: 'review-where-chip',
            renderContent: <View testID="review-where-content" />,
        }), controlId: 'machine' as const };
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}} extraActionChips={[where]} />);
        expect(screen.findByTestId('review-where-chip')).not.toBeNull();
        await screen.pressByTestIdAsync('review-where-chip');
        expect(screen.findByTestId('review-where-content')).not.toBeNull();
    });
    it.each([[['team-a']], [['team-a', 'team-b']]])('reviews only granted Teams before admitting the draft (%j)', async (teamIds) => {
        await offerTeams(teamIds);
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { body: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner',
                grants: [
                    ...teamIds.map(teamId => ({ principal: { kind: 'team', teamId }, accessLevel: 'edit',
                        createdByAccountId: 'account-a', createdAt: 1, display: { name: teamId === 'team-a' ? 'Builders' : 'Reviewers' } })),
                    { principal: { kind: 'account', accountId: 'friend' }, accessLevel: 'view',
                        createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Friend' } },
                ] }) });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [], defaults: STARTABLE_DEFAULTS })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-visibility-chip')).not.toBeNull());
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
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { body: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner',
            grants: [{ principal: { kind: 'team', teamId: 'team-a' }, accessLevel: 'edit',
                createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Builders' } }] }) });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [], defaults: STARTABLE_DEFAULTS })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        expect(screen.findByTestId('workflow-run-inputs-team-required')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, [], 'team-a');
    });
    it('excludes an unreadable Team even when the caller can use its Artifact', async () => {
        await offerTeams(['team-a']);
        const artifact = home.artifacts(appliedHome.serverId).read('saved-workflow');
        if (!artifact) throw new Error('saved_workflow_fixture_missing');
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow', { body: { ...artifact, ownerAccountId: 'someone-else', access: 'view' } });
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { body: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'saved-workflow', ownerAccountId: 'someone-else', access: 'view',
            grants: ['team-a', 'team-hidden'].map(teamId => ({ principal: { kind: 'team', teamId }, accessLevel: 'view',
                createdByAccountId: 'someone-else', createdAt: 1, display: { name: teamId } })) }) });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [], defaults: STARTABLE_DEFAULTS })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
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
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { status: 400, body: { error: 'artifact_access_unavailable' } });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer sourceArtifactId="saved-workflow"
            definition={createWorkflowDefinitionFixture({ inputs: [], defaults: STARTABLE_DEFAULTS })} inputs={[]} values={{}}
            onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-visibility-retry')).not.toBeNull());
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { body: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner', grants: [] }) });
        await screen.pressByTestIdAsync('workflow-run-inputs-visibility-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, []);
    });
    it('discards a late grant read when the reviewed source changes to an unbound inline draft', async () => {
        const { createDeferred } = await import('@/dev/testkit');
        const grants = createDeferred<void>();
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { respondAfter: grants.promise,
            body: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner',
                grants: [{ principal: { kind: 'team', teamId: 'team-old' }, accessLevel: 'edit', createdByAccountId: 'account-a', createdAt: 1, display: { name: 'Old Team' } }] }),
        });
        let changeSource!: (source: string | null) => void;
        const onRun = vi.fn();
        function Host() {
            const [source, setSource] = React.useState<string | null>('saved-workflow');
            changeSource = setSource;
            return <WorkflowRunComposer sourceArtifactId={source} definition={createWorkflowDefinitionFixture({ inputs: [], defaults: STARTABLE_DEFAULTS })}
                inputs={[]} values={{}} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />;
        }
        const screen = await renderScreen(<Host />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        const { act } = await import('react-test-renderer');
        await act(async () => { changeSource(null); });
        await act(async () => { grants.resolve(undefined); });
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
        const roleOverrides = [{ roleId: 'builder', workspaceWrites: 'deny' as const }];
        const definition = createWorkflowDefinitionFixture({ defaults: { engine: { role: 'builder' } } });
        const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition, roleOverrides,
            roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.claude/claude' } },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
            context: { source: { kind: 'saved', definitionId: 'saved-workflow', revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
                inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
        });
        if (!materialized.ok) throw new Error(`invalid_accepted_fixture:${materialized.error.code}`);
        const run = createWorkflowRunSummaryFixture({ id: 'own-run', ownerAccountId: 'account-a', sourceArtifactId: 'saved-workflow' });
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-a', runId: run.id }, acceptedSnapshot: materialized.snapshot }));
        const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: 'account-a', access: 'owner',
            encryptionMode: 'plain', visibleTeamId: null, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        home.answer(appliedHome.serverId, '/v1/artifacts/saved-workflow/access/grants', { body: ArtifactAccessGrantsListResponseV1Schema.parse({
            artifactId: 'saved-workflow', ownerAccountId: 'account-a', access: 'owner', grants: [],
        }) });
        const route = '/v3/automations/runs/workflow-storage';
        home.answer(appliedHome.serverId, route, { select: (input) => {
            if (!input || typeof input !== 'object' || !('operation' in input)) throw new Error('invalid_storage_request');
            if (input.operation === 'list') return { body: { runs: [
                createWorkflowRunSummaryFixture({ id: 'teammate', ownerAccountId: 'teammate', sourceArtifactId: 'saved-workflow' }), run,
            ], acceptedEnvelopesByRunId: { [run.id]: acceptedEnvelope }, keyCensusByRunId: { [run.id]: keyCensus } } };
            if (input.operation === 'get') return { body: { run, acceptedEnvelope, keyCensus, checkpointEnvelope: null, resultEnvelope: null } };
            if (input.operation === 'invocations.list') return { body: { invocations: [], progressEnvelopesByInvocationId: {} } };
            throw new Error(`unexpected_storage_request:${String(input.operation)}`);
        } });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer definition={definition} sourceArtifactId="saved-workflow"
            inputs={[]} values={{}} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(undefined, roleOverrides);
        expect(home.requestsFor(route).filter(request => request.input && typeof request.input === 'object'
            && 'operation' in request.input && request.input.operation === 'get').map(request => request.input)).toEqual([
            { operation: 'get', runId: 'own-run' },
        ]);
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
    it('never asks for what the host binds: Another round fills the previous round, a trigger its fingerprint', async () => {
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer inputs={[{ name: 'diffFingerprint', valueType: 'string', required: false },
            { name: 'request', valueType: 'string', required: true },
            { name: 'previousRoundContext', valueType: 'json', required: false, default: null }]}
            values={{ request: 'Plan the release' }} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />);
        expect(screen.findAllByTestId('workflow-run-inputs-inputs-chip')).toHaveLength(0);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith({ request: 'Plan the release', previousRoundContext: null });
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
            onCancel={() => {}} startProblem={{ message: 'workflows.problem.targetUnavailable' }} />);
        expect(screen.findByTestId('workflow-run-inputs-reason')?.props.accessibilityRole).toBe('alert');
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe('workflows.problem.targetUnavailable');
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });

    it('discloses the typed Start code and owner reason without exposing the failure payload', async () => {
        const { resolveWorkflowProblemPresentation } = await import('../presentation/workflowProblemPresentation');
        const { WorkflowActionError } = await import('@/sync/domains/workflows/workflowActionError');
        const failure = { ok: false, errorCode: 'content_unavailable', error: 'private payload must stay hidden',
            details: { reason: 'account_role_overrides_unavailable' } } as const;
        const problem = resolveWorkflowProblemPresentation(new WorkflowActionError({ rawCode: failure.errorCode,
            message: failure.error, failure }));
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}}
            onRun={() => {}} onCancel={() => {}} startProblem={problem} />);
        await screen.pressByTestIdAsync('workflow-run-inputs-start-problem-details.header');
        expect(screen.getTextContent()).toContain('content_unavailable');
        expect(screen.getTextContent()).toContain('account_role_overrides_unavailable');
        expect(screen.getTextContent()).not.toContain(failure.error);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });

    it.each([
        ['another_round', 'workflows.start.retry.anotherRound'],
        ['ordinary', 'workflows.start.retry.runAgain'],
        ['start', 'workflows.start.retry.start'],
    ] as const)('reviews an unresolved %s request exactly as sent, read-only, with Start meaning try that request again', async (kind, line) => {
        const onRun = vi.fn();
        const sent = { brief: 'Original brief', version: 2, announce: false };
        const retainedRequest = { unresolved: true, input: {
            runId: '00000000-0000-4000-8000-000000000001',
            source: { kind: 'inline' as const, definition: { blocks: ['Build'] },
                ...(kind === 'start' ? {} : { replay: { runId: '11111111-1111-4111-8111-111111111111',
                    ...(kind === 'another_round' ? { intent: 'another_round' as const } : {}) } }) },
            inputs: sent,
        } };
        const screen = await renderScreen(<WorkflowRunComposer inputs={inputs} values={{ brief: 'Edited brief', version: 9 }}
            rawTextValues={{ brief: 'Typed after the lost reply' }} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}}
            startProblem={{ message: 'workflows.problem.unresolvedOutcome' }} retainedRequest={retainedRequest} />);
        const input = screen.findByTestId('new-session-composer-input');
        expect(input?.props.value).toBe('Original brief');
        expect(input?.props.editable ?? !input?.props.disabled).toBe(false);
        expect(screen.findByTestId('workflow-run-inputs-reason-text')?.props.children).toBe(line);
        const start = screen.findByTestId('workflow-run-inputs-run');
        expect(start?.props.accessibilityLabel).toBe('workflows.start.retry.action');
        expect(start?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).toHaveBeenCalledWith(sent);
    });

    it('keeps a no-text workflow inspectable without a dead editable input', async () => {
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}} onRun={() => {}} onCancel={() => {}}
            definition={createWorkflowDefinitionFixture({ defaults: STARTABLE_DEFAULTS })} preview={'Build\nReview\nRelease'} />);
        expect(screen.findByTestId('workflow-run-inputs-preview')).not.toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-summary')).not.toBeNull();
        expect(screen.findByTestId('new-session-composer-input')).toBeNull();
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false);
    });

    it('starts from the workflow command while open and respects the same required-input admission', async () => {
        getStorage().getState().applySettingsLocal({ keyboardShortcutsV2Enabled: true });
        const onRun = vi.fn();
        let executeCommand: ReturnType<typeof useKeyboardCommand> = () => false;
        function Commands() { executeCommand = useKeyboardCommand(); return null; }
        const content = (values: React.ComponentProps<typeof WorkflowRunComposer>['values']) => (
            <KeyboardShortcutProvider handlers={{}}>
                <WorkflowRunComposer inputs={[{ name: 'brief', valueType: 'string', required: true }]}
                    values={values} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />
                <Commands />
            </KeyboardShortcutProvider>
        );
        const screen = await renderScreen(content({}));
        const start = screen.findByTestId('workflow-run-inputs-run');
        // The key hint reads beneath Start (convo-N7), not inside its pill.
        expect(start?.findAllByProps({ testID: 'workflow-run-inputs-shortcut' }).length).toBe(0);
        expect(screen.findByTestId('workflow-run-inputs-footer')?.findAllByProps({ testID: 'workflow-run-inputs-shortcut' }).length).toBeGreaterThan(0);
        expect(start?.props.accessibilityLabel).toBe('workflows.start.start');
        const { act } = await import('react-test-renderer');
        await act(async () => { executeCommand('workflow.run'); });
        expect(onRun).not.toHaveBeenCalled();
        await screen.update(content({ brief: 'Release' }));
        await act(async () => { executeCommand('workflow.run'); });
        expect(onRun).toHaveBeenCalledWith({ brief: 'Release' });
    });

    it('names the run key once: hung from a trigger that already shows it, Start keeps the command but drops its hint', async () => {
        getStorage().getState().applySettingsLocal({ keyboardShortcutsV2Enabled: true });
        const onRun = vi.fn();
        let executeCommand: ReturnType<typeof useKeyboardCommand> = () => false;
        function Commands() { executeCommand = useKeyboardCommand(); return null; }
        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <WorkflowRunComposer inputs={[{ name: 'brief', valueType: 'string', required: true }]} triggerNamesShortcut
                    values={{ brief: 'Release' }} onChangeValues={() => {}} onRun={onRun} onCancel={() => {}} />
                <Commands />
            </KeyboardShortcutProvider>,
        );
        expect(screen.findByTestId('workflow-run-inputs-shortcut')).toBeNull();
        const { act } = await import('react-test-renderer');
        await act(async () => { executeCommand('workflow.run'); });
        expect(onRun).toHaveBeenCalledWith({ brief: 'Release' });
    });

    it('keeps Start unavailable for a definition rejected by the canonical validator', async () => {
        const definition = createWorkflowDefinitionFixture({ defaults: STARTABLE_DEFAULTS });
        const onRun = vi.fn();
        const screen = await renderScreen(<WorkflowRunComposer inputs={[]} values={{}} onChangeValues={() => {}}
            onRun={onRun} onCancel={() => {}} definition={{ ...definition, blocks: [] }} />);
        expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        expect(onRun).not.toHaveBeenCalled();
        expect(screen.findByTestId('workflow-run-inputs-reason')).not.toBeNull();
    });

    it('retains the workflow command across the real globally hosted modal boundary', async () => {
        const onRun = vi.fn();
        let executeCommand: ReturnType<typeof useKeyboardCommand> = () => false;
        function Presenter({ open }: Readonly<{ open: boolean }>) {
            executeCommand = useKeyboardCommand();
            return useWorkflowRunComposerModal({ open, props: {
                inputs: [], values: {}, onChangeValues: () => {}, onRun, onCancel: () => {},
            } });
        }
        const content = (open: boolean) => <ModalProvider>
            <KeyboardShortcutProvider handlers={{}}><Presenter open={open} /></KeyboardShortcutProvider>
        </ModalProvider>;
        const screen = await renderScreen(content(false));
        await screen.update(content(true));
        expect(screen.findByTestId('workflow-run-inputs-run')).not.toBeNull();
        const { act } = await import('react-test-renderer');
        await act(async () => { executeCommand('workflow.run'); });
        expect(onRun).toHaveBeenCalledWith(undefined);
        onRun.mockClear();
        await screen.update(content(false));
        await act(async () => { executeCommand('workflow.run'); });
        expect(onRun).not.toHaveBeenCalled();
    });

    it('focuses the defaulted Test-run input through the real hosted modal only when Start becomes ready', async () => {
        const focus = vi.fn();
        const onRun = vi.fn();
        function Presenter({ open, ready }: Readonly<{ open: boolean; ready: boolean }>) {
            return useWorkflowRunComposerModal({ open, props: {
                inputs: [{ name: 'qa_note', valueType: 'string', required: false, default: 'Saved note' }],
                values: {}, onChangeValues: () => {}, onRun, onCancel: () => {}, startDisabled: !ready,
            } });
        }
        const content = (open: boolean, ready: boolean) => <ModalProvider><Presenter open={open} ready={ready} /></ModalProvider>;
        const screen = await renderScreen(content(false, false), {
            createNodeMock: element => element.type === 'TextInput' || element.type === 'textarea' || element.type === 'HappierComposerInput'
                ? { focus, blur: vi.fn(), setNativeProps: vi.fn(), setTextAndSelection: vi.fn(), setSelection: vi.fn() } : null,
        });
        await screen.update(content(true, false));
        expect(screen.findByTestId('new-session-composer-input')?.props.value).toBe('Saved note');
        expect(focus).not.toHaveBeenCalled();
        await screen.update(content(true, true));
        expect(focus).toHaveBeenCalledTimes(1);
        await screen.update(content(true, false));
        await screen.update(content(true, true));
        expect(focus).toHaveBeenCalledTimes(1);
        expect(onRun).not.toHaveBeenCalled();
    });
});
