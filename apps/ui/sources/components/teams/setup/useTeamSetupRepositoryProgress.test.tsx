import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import 'fake-indexeddb/auto';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createMachineAdministrationTargetSelectionFixture } from '@/dev/testkit/fixtures/machineAdministrationTargetSelectionFixtures';
import { teamProjectSourceFixture } from '@/dev/testkit/fixtures/teamFixtures';

// The Socket.IO port supplies daemon answers; Machine routing, credential
// currentness and operation observation remain in the production owners.
const daemonReply = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const daemonRequests = installSessionActionRpcBoundary((request, context) => daemonReply(request, context));
const { useTeamSetupRepositoryProgress } = await import('./useTeamSetupRepositoryProgress');
const { useTeamSetupBatchProgress } = await import('./useTeamSetupBatchProgress');
const { TeamSetupPlanProvider, useRetainedTeamSetupPlan } = await import('./TeamSetupPlanProvider');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
const { PresentationNoticeHost } = await import('@/components/sessions/presentation/PresentationNoticeHost');
import type { TeamSetupBatch } from './useTeamSetupPlan';
await import('@/sync/domains/actionOperations/observeActionOperationByRequestId');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
let lifetime: ServerAccountScopeLifetime;
let homeProfileId: string;
const homeId = 'srv_team_setup_progress';
beforeEach(async () => {
    await homes.reset();
    daemonRequests.length = 0;
    daemonReply.mockReset();
    homeProfileId = await homes.addHome({ name: 'Team Home', serverUrl: 'https://team-home.test',
        serverIdentityId: homeId, accountId: 'member', currentAccount: true });
    query.serverId = resolveServerProfileScopeIdForIdentifier(homeProfileId);
    preparedResult = preparedResultFixture();
    homes.answer(homeProfileId, '/v1/machines/member-machine', { body: { machine: createPlainMachineRowFixture({
        id: 'member-machine', accountId: 'member',
    }) } });
    const resolution = await resolveServerCredentialAccountScope(query.serverId);
    if (resolution.kind !== 'bound') throw new Error(`Expected bound Home Account, received ${resolution.kind}`);
    lifetime = captureServerCredentialAccountScopeLifetime(resolution);
});
afterEach(async () => {
    retirePresentationNotice();
    standardCleanup();
    actionOperationStore.reset();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
});
const query = { serverId: 'team-home', accountId: 'member', machineId: 'member-machine', sourceId: 'source' };
function opening(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    const createdAt = overrides.createdAt ?? 1;
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'open', revision: 1, actionId: 'projects.open', state: 'running',
        scope: { accountId: 'member', machineId: 'member-machine' }, title: 'Open', createdAt, startedAt: createdAt,
        cancellation: 'unsupported', domainRef: { kind: 'projectOpen', sourceId: 'source' }, ...overrides });
}
function selectedBatch(): TeamSetupBatch {
    return { selection: { team: { serverId: query.serverId, teamId: 'team' }, lifetime,
        target: { serverId: query.serverId, homeId: 'home', machineId: query.machineId },
        repositories: [
            { repositoryId: 'source', source: { id: 'source', revision: 2, name: 'Shared repository' }, requestId: 'selected-request' },
            { repositoryId: 'next', source: { id: 'next', revision: 1, name: 'Next repository' }, requestId: 'next-request' },
        ] }, dispatched: new Set(['source']), running: true, completed: false, settlement: null };
}
function preparedResultFixture() {
    const result = OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'prepared', directory: '/repo',
        workspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'repo', rootPath: '/repo' } });
    if (result.kind !== 'opened') throw new Error('Expected the opened Project fixture');
    return result;
}
let preparedResult = preparedResultFixture();
function setupOperation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'setup', revision: 1, actionId: 'projects.prepare',
        state: 'running', scope: { accountId: query.accountId, machineId: query.machineId }, title: 'Prepare',
        createdAt: 3, startedAt: 3, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'setup',
            serverId: query.serverId, machineId: query.machineId, workspaceRefId: 'repo', cwd: '/repo',
            sourceWorkspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'repo', rootPath: '/repo' } },
        ...overrides });
}
describe('selected Team batch progress', () => {
    it('retains the native Machine operation while its Team Setup page is absent', async () => {
        const apply = vi.fn(async () => ({ operationId: 'native-apply' }));
        const read = createDeferred<unknown>();
        const executor = createActionExecutor({
            machineSetupApply: apply,
            actionOperationAction: async () => read.promise,
        });
        const execute = createFrontDoorActionExecute({ ...executor, executeConfirmed: (id, input, context) =>
            executor.execute(id, input, bindPresentUserActionConfirmation(id, input, context ?? {})) });
        const context = { serverId: query.serverId, surface: 'ui', authority: 'present_user',
            runtimeAccountId: query.accountId, expectedAccountId: query.accountId, serverIdentityId: homeId,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) } as const;
        const target = { serverId: query.serverId, homeId, machineId: query.machineId };
        let controller!: ReturnType<typeof useRetainedTeamSetupPlan>;
        function Page() {
            controller = useRetainedTeamSetupPlan();
            return null;
        }
        const view = (showPage: boolean) => <TeamSetupPlanProvider context={context} execute={execute}>
            {showPage ? <Page /> : null}
        </TeamSetupPlanProvider>;
        const screen = await renderScreen(view(true));
        let pending!: ReturnType<typeof controller.run>;
        try {
            act(() => {
                pending = controller.run({
                    plan: { target, repositories: [], machine: { ok: true, facts: [], input: {
                        homeId, machineId: query.machineId, targets: [{
                            homeId, machineId: query.machineId, desiredRevision: 1,
                            sources: [{ kind: 'direct', setup: {} }], recipePlans: [],
                        }],
                    } } },
                    selection: { team: { serverId: query.serverId, teamId: 'team' }, lifetime, sources: [] },
                });
            });
            await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
            await screen.update(view(false));
            await screen.update(view(true));
            expect(controller.batch).toMatchObject({ running: true, machine: { ok: true, result: { operationId: 'native-apply' } } });
        } finally {
            await act(async () => {
                read.resolve({ kind: 'found', operation: { ...opening(), operationId: 'native-apply',
                    actionId: 'machines.setup.apply', state: 'succeeded', settledAt: 2 } });
                await pending;
            });
            await screen.unmount();
        }
        expect(apply).toHaveBeenCalledOnce();
    });
    it.each(['source', 'folder'] as const)('opens the exact %s draft from the ready notice after leaving Joined Setup', async kind => {
        const openProject = createDeferred<typeof preparedResult>();
        const domainRef = kind === 'source' ? { kind: 'projectOpen', sourceId: query.sourceId } as const : undefined;
        const result = kind === 'source' ? preparedResult : { ...preparedResult, setup: 'approvalRequired' as const };
        const openDraft = vi.fn(async () => ({ kind: 'opened', draftId: 'new-draft', destination: 'newSession' } as const));
        let nativeRequestId: string | undefined;
        const executor = createActionExecutor({ projectsOpen: (_input, context) => {
            nativeRequestId = context.actionRequestId ?? undefined;
            return openProject.promise;
        }, sessionAuthoringOpen: openDraft });
        const execute = createFrontDoorActionExecute({ ...executor, executeConfirmed: (id, input, context) =>
            executor.execute(id, input, bindPresentUserActionConfirmation(id, input, context ?? {})) });
        const context = { serverId: query.serverId, surface: 'ui', authority: 'present_user',
            runtimeAccountId: query.accountId, expectedAccountId: query.accountId, serverIdentityId: homeId,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) } as const;
        let controller!: ReturnType<typeof useRetainedTeamSetupPlan>;
        let leaveReview!: () => void;
        let isPresented = true;
        function Review() {
            controller = useRetainedTeamSetupPlan();
            React.useLayoutEffect(() => () => { isPresented = false; }, []);
            return null;
        }
        function App() {
            const [review, setReview] = React.useState(true);
            leaveReview = () => setReview(false);
            return <TeamSetupPlanProvider execute={execute} context={context}>
                {review ? <Review /> : null}<PresentationNoticeHost />
            </TeamSetupPlanProvider>;
        }
        daemonReply.mockReturnValue(new Promise(() => {}));
        const screen = await renderScreen(<App />);
        const source = { id: query.sourceId, name: 'Shared repository', revision: 2 };
        const plan = await controller.prepare({ target: { serverId: query.serverId, homeId, machineId: query.machineId },
            repositories: [{ id: source.id, input: { source: kind === 'source' ? { kind, id: source.id, revision: source.revision,
                selector: { provider: { id: 'github', kind: 'github', baseUrl: 'https://github.com', displayName: 'GitHub' },
                    repository: { nameWithOwner: 'example/repo', cloneUrl: 'https://github.com/example/repo.git' }, protocol: 'https' },
            } : { kind, path: '/repo' },
                materialization: { kind: 'attach' } } }],
            isCurrent: () => true });
        if (!plan?.ok) throw new Error('Could not review the selected repository');
        let run!: ReturnType<typeof controller.run>;
        await act(async () => {
            run = controller.run({ plan: plan.plan, selection: { team: { serverId: query.serverId, teamId: 'team' },
                lifetime, sources: [source], retireOffer: false, isReviewPresented: () => isPresented } });
        });
        const requestId = controller.batch?.selection.repositories[0]?.requestId;
        if (!requestId) throw new Error('No native request from the selected batch');
        expect(nativeRequestId).toBe(requestId);
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ requestId, domainRef, createdAt: 3 }),
                setupOperation({ operationId: 'previous-setup', createdAt: 1, startedAt: 1, state: 'succeeded', settledAt: 2 })] }));
        act(() => leaveReview());
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ requestId, domainRef, revision: 2, state: 'succeeded', createdAt: 3, settledAt: 4, result }),
                opening({ operationId: 'unrelated-open', requestId: 'unrelated-request', domainRef,
                    state: 'succeeded', createdAt: 4, settledAt: 5, result: { ...result, setup: 'notRequired' } })] }));
        await act(async () => { openProject.resolve(result); await run; });
        expect(readPresentationNotice()).toBeNull();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId,
            snapshots: [setupOperation({ createdAt: 5, startedAt: 5 })] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({ revision: 2,
            createdAt: 5, startedAt: 5, state: 'succeeded', settledAt: 6 })] }));
        expect(readPresentationNotice()?.message).toBe('Shared repository is ready');
        expect(openDraft).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('current-session-presentation-notice-action');
        expect(openDraft).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: { seed: {
            placement: { kind: 'exactTarget', serverId: query.serverId, machineId: query.machineId, directory: '/repo' },
        } } }));
        act(() => actionOperationStore.setMachineObservation(query, 'reconnecting'));
        act(() => actionOperationStore.setMachineObservation(query, 'available'));
        expect(readPresentationNotice()).toBeNull();
        // The selected Open and its current Setup each join their own finite owner once.
        expect(daemonRequests.map(request => request.params)).toEqual([
            expect.objectContaining({ requestIdentity: { actionId: 'projects.open', requestId } }),
            expect.objectContaining({ operationId: 'setup', waitForTerminal: true }),
        ]);
    });
    it('queues only explicit pending selection and stops queuing when its runner settles', async () => {
        const batch = selectedBatch();
        let current: TeamSetupBatch | null = batch;
        const hook = await renderHook(() => ({
            pending: useTeamSetupBatchProgress(current, 'next'),
            unrelated: useTeamSetupBatchProgress(current, 'unrelated'),
        }));
        expect(hook.getCurrent().pending).toMatchObject({ phase: 'queued', queued: true, ready: false, dispatched: false,
            source: { id: 'next', revision: 1, name: 'Next repository' } });
        expect(hook.getCurrent().unrelated).toBeNull();
        expect(daemonReply).not.toHaveBeenCalled();
        current = { ...batch, running: false, settlement: { completed: false, machine: { ok: false, errorCode: 'setup_failed', error: 'Setup failed' },
            machineSettlement: null, repositories: [] } };
        await hook.rerender();
        expect(hook.getCurrent().pending).toMatchObject({ phase: 'failed', queued: false, ready: false,
            settlement: { machine: { ok: false, errorCode: 'setup_failed' } } });
        current = null;
        await hook.rerender();
        expect(hook.getCurrent().pending).toBeNull();
        await hook.unmount();
    });
    it('follows a later checkout’s native review and settlement on the mounted batch', async () => {
        const [{ TeamSetupPageView }, { ItemList }, { ModalProvider }, { answerExternalActionAccountForHome }] = await Promise.all([
            import('./TeamSetupScreen'), import('@/components/ui/lists/ItemList'), import('@/modal'),
            import('@/dev/testkit/harness/externalActionAccountHttpBoundary'),
        ]);
        daemonReply.mockReturnValue(new Promise(() => {}));
        let batch = selectedBatch();
        const first = { ...preparedResult, setup: 'notRequired' as const, directory: '/first',
            workspace: { ...preparedResult.workspace, workspaceId: 'first', rootPath: '/first' } };
        const second = { ...preparedResult, setup: 'approvalRequired' as const };
        batch = { ...batch, settlement: { completed: false, machine: null, machineSettlement: null,
            repositories: [{ id: 'source', result: { ok: true, result: first } }] } };
        const repositories = [teamProjectSourceFixture({ id: 'source', name: 'First', nameWithOwner: 'team/first' }),
            teamProjectSourceFixture({ id: 'next', name: 'Next', nameWithOwner: 'team/next' })];
        const settled = setupOperation({ revision: 2, createdAt: 5, startedAt: 5, state: 'succeeded', settledAt: 6 });
        const approve = vi.fn((_input: unknown) => ({ operation: settled }));
        await answerExternalActionAccountForHome(homes, homeProfileId, {
            machineId: query.machineId, actionId: 'projects.prepare', tokenEpoch: 0, requesterInvocation: 'optional',
            execute: approve,
        });
        const view = () => <ModalProvider><ItemList pageColumn="wide"><TeamSetupPageView
            header={null} teamName="Team" selection={createMachineAdministrationTargetSelectionFixture()}
            machineId={query.machineId} machineLabel="Member Machine" homeDir="/home/member"
            run={{ kind: 'done', completed: false, operationId: null }} canRun={false} onRun={vi.fn()}
            onOpenOperation={vi.fn()} sources={{ loading: false, failure: null, onRetry: vi.fn() }}
            hasPreset={false} machinePlan={null} repositories={repositories} repositoryFreeSources={[]}
            excluded={new Set()} onToggleRepository={vi.fn()} batch={batch} sharedKeys={[]} keyDisplayNames={{}}
            firstTask={null} onStartSession={vi.fn()} presetChange={null}
            clones={{ onFind: vi.fn(), searching: false, folder: null, adopted: new Map(), failure: null, noneFound: false }}
        /></ItemList></ModalProvider>;
        const screen = await renderScreen(view());
        try {
            expect(screen.findByTestId('team-setup-repository-start:source')).not.toBeNull();
            expect(screen.findByTestId('team-setup-repository-start:next')).toBeNull();
            batch = { ...batch, dispatched: new Set(['source', 'next']), running: false,
                settlement: { ...batch.settlement!, repositories: [
                    ...batch.settlement!.repositories, { id: 'next', result: { ok: true, result: second } },
                ] } };
            await screen.update(view());
            const review = setupOperation({ createdAt: 5, startedAt: 5, setupReview: {
                kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'effect',
                reviewedEffect: { commands: [] },
            } });
            act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [
                opening({ operationId: 'second-open', requestId: 'next-request', domainRef: { kind: 'projectOpen', sourceId: 'next' },
                    createdAt: 3, state: 'succeeded', settledAt: 4 }), review,
            ] }));
            expect(screen.findByTestId('team-setup-repository-start:next')).toBeNull();
            await screen.pressByTestIdAsync('team-setup-repository:next');
            const reviewId = `project-setup-session-review:${review.operationId}`;
            await vi.waitFor(() => expect(screen.findByTestId(`${reviewId}.scope:thisTime`)).not.toBeNull());
            expect(approve).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync(`${reviewId}.scope:thisTime`);
            await screen.pressByTestIdAsync(`${reviewId}-approve`);
            await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
            expect(approve.mock.calls[0]?.[0]).toMatchObject({ phase: 'setup', heldOperationId: review.operationId,
                expectedEffectDigest: 'effect', consentScope: 'thisTime',
                workspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'repo', rootPath: '/repo' } });
            act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [settled] }));
            expect(screen.findByTestId('team-setup-repository-start:source')).not.toBeNull();
            expect(screen.findByTestId('team-setup-repository-start:next')).not.toBeNull();
        } finally { await screen.unmount(); }
    });
    it('refreshes a mounted checkout’s change notice only when its Source publishes a different setup', async () => {
        const [{ TeamSetupPageView }, { ItemList }, { answerExternalActionAccountForHome }, { resolveProjectDefinitionV1 }] = await Promise.all([
            import('./TeamSetupScreen'), import('@/components/ui/lists/ItemList'),
            import('@/dev/testkit/harness/externalActionAccountHttpBoundary'),
            import('@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1'),
        ]);
        const id = 'shared-source';
        const workspace = { id: 'checkout', serverId: query.serverId, machineId: query.machineId,
            rootPath: '/checkout', createdAtMs: 1, source: { sourceId: id, revision: 1 } };
        const checkouts = new Map([[id, workspace]]);
        const attachment = (bodyVersion: number) => ({
            purpose: 'setup' as const, ref: { kind: 'doc' as const, artifactId: 'shared-setup' },
            contentRevision: { headerVersion: 1, bodyVersion },
        });
        let source = { ...teamProjectSourceFixture({ id, name: 'Shared repository', nameWithOwner: 'team/repo' }),
            attachments: [attachment(1)] };
        const manifest = { version: 1 as const, workspace: { setup: [{ kind: 'command' as const, command: 'printf updated' }] } };
        const inspect = vi.fn((_input: unknown) => ({
            definition: { basis: { kind: 'absent' }, document: null },
            detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
            importCandidates: [],
            effectiveDefinition: resolveProjectDefinitionV1({ repositoryManifest: null,
                ...(source.attachments[0]?.contentRevision.bodyVersion === 2 ? {
                    pendingSharedSetup: { source, setup: { sourceId: id, contentRevision: attachment(2).contentRevision,
                        digest: 'a'.repeat(64) }, manifest },
                } : {}),
            }),
        }));
        await answerExternalActionAccountForHome(homes, homeProfileId, {
            machineId: query.machineId, actionId: 'projects.inspect', tokenEpoch: 0, requesterInvocation: 'none', execute: inspect,
        });
        const view = () => <ItemList pageColumn="wide"><TeamSetupPageView
            header={null} teamName="Team" selection={createMachineAdministrationTargetSelectionFixture()}
            machineId={query.machineId} machineLabel="Member Machine" homeDir="/home/member"
            run={{ kind: 'idle' }} canRun={false} onRun={vi.fn()} onOpenOperation={vi.fn()}
            sources={{ loading: false, failure: null, onRetry: vi.fn() }}
            hasPreset={false} machinePlan={null} repositories={[source]} repositoryFreeSources={[]} checkouts={checkouts}
            excluded={new Set()} onToggleRepository={vi.fn()} batch={null} sharedKeys={[]} keyDisplayNames={{}}
            firstTask={null} presetChange={null}
            clones={{ onFind: vi.fn(), searching: false, folder: null, adopted: new Map(), failure: null, noneFound: false }}
        /></ItemList>;
        const screen = await renderScreen(view());
        const noticeId = `team-setup-source-changed:${id}`;
        try {
            await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
            expect(screen.findByTestId(noticeId)).toBeNull();
            source = { ...source, name: 'Renamed repository', revision: 2 };
            await screen.update(view());
            expect(inspect).toHaveBeenCalledOnce();
            source = { ...source, revision: 3, attachments: [attachment(2)] };
            await screen.update(view());
            await vi.waitFor(() => expect(screen.findByTestId(noticeId)).not.toBeNull());
            expect(inspect).toHaveBeenCalledTimes(2);
            expect(inspect.mock.calls[1]?.[0]).toMatchObject({
                workspace: { workspaceId: 'checkout', machineId: query.machineId, rootPath: '/checkout' },
                read: { kind: 'setup' },
            });
        } finally { await screen.unmount(); }
    });
    it('keeps the plan arriving until a found checkout’s setup readiness answers, so its row lands once as Ready', async () => {
        // Cold load at 600 ms (TS-GAPS-ACCEPT-1125 run 1): the rows landed with an include switch, then the checkout's
        // readiness answered and the row swapped the switch for Ready while rows below dropped.
        const [{ TeamSetupPageView }, { ItemList }, { answerExternalActionAccountForHome }, { resolveProjectDefinitionV1 }] = await Promise.all([
            import('./TeamSetupScreen'), import('@/components/ui/lists/ItemList'),
            import('@/dev/testkit/harness/externalActionAccountHttpBoundary'),
            import('@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1'),
        ]);
        const id = 'ready-source';
        const workspace = { id: 'ready-checkout', serverId: query.serverId, machineId: query.machineId,
            rootPath: '/checkout/ready', createdAtMs: 1, source: { sourceId: id, revision: 1 } };
        const source = teamProjectSourceFixture({ id, name: 'Ready repository', nameWithOwner: 'team/ready' });
        const answer = createDeferred<void>();
        await answerExternalActionAccountForHome(homes, homeProfileId, {
            machineId: query.machineId, actionId: 'projects.inspect', tokenEpoch: 0, requesterInvocation: 'none',
            execute: async () => {
                await answer.promise;
                return {
                    definition: { basis: { kind: 'absent' }, document: null },
                    detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
                    importCandidates: [],
                    effectiveDefinition: resolveProjectDefinitionV1({ repositoryManifest: null }),
                    setupReadiness: { kind: 'current', reviewedEffectDigest: 'reviewed', completedAtMs: 1 },
                };
            },
        });
        const screen = await renderScreen(<ItemList pageColumn="wide"><TeamSetupPageView
            header={null} teamName="Team" selection={createMachineAdministrationTargetSelectionFixture()}
            machineId={query.machineId} machineLabel="Member Machine" homeDir="/home/member"
            run={{ kind: 'idle' }} canRun onRun={vi.fn()} onOpenOperation={vi.fn()} onStartSession={vi.fn()}
            sources={{ loading: false, failure: null, onRetry: vi.fn() }} arriving={false}
            hasPreset={false} machinePlan={null} repositories={[source]} repositoryFreeSources={[]}
            checkouts={new Map([[id, workspace]])}
            excluded={new Set()} onToggleRepository={vi.fn()} batch={null} sharedKeys={[]} keyDisplayNames={{}}
            firstTask={null} presetChange={null}
            clones={{ onFind: vi.fn(), searching: false, folder: null, adopted: new Map(), failure: null, noneFound: false }}
        /></ItemList>);
        try {
            // The page's own reads settled, but this row's final shape is not known yet: one line stands for the plan.
            expect(screen.findByTestId('team-setup-sources-loading')).not.toBeNull();
            expect(screen.findByTestId('team-setup-repositories-frame')?.props.style).toMatchObject({ visibility: 'hidden' });
            expect(screen.findByTestId('team-setup-run')).toBeNull();
            answer.resolve();
            await vi.waitFor(() => expect(screen.findByTestId(`team-setup-repository-start:${id}`)).not.toBeNull());
            expect(screen.findByTestId('team-setup-sources-loading')).toBeNull();
            expect(screen.findByTestId('team-setup-repositories-frame')?.props.style).toBeUndefined();
            expect(screen.findByTestId(`team-setup-repository-include:${id}`)).toBeNull();
        } finally { answer.resolve(); await screen.unmount(); }
    });
    it('requires actual setup success, retains native failure, and announces only a live ready transition', async () => {
        daemonReply.mockReturnValue(new Promise(() => {}));
        const batch = selectedBatch();
        const onReady = vi.fn();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ requestId: 'selected-request', state: 'succeeded', settledAt: 2, result: preparedResult })] }));
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(hook.getCurrent()).toMatchObject({ phase: 'prepared', queued: false, ready: false });
        expect(hook.getCurrent()?.readyProject).toBeNull();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation()] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({ revision: 2,
            state: 'failed', settledAt: 4, error: { errorCode: 'setup_exit_nonzero', error: 'Setup failed' } })] }));
        expect(hook.getCurrent()).toMatchObject({ phase: 'failed', ready: false,
            progress: { setupOperation: { snapshot: { state: 'failed', error: { errorCode: 'setup_exit_nonzero' } } } } });
        expect(onReady).not.toHaveBeenCalled();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({
            operationId: 'retry', createdAt: 5, startedAt: 5 })] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({
            operationId: 'retry', revision: 2, createdAt: 5, startedAt: 5, state: 'succeeded', settledAt: 6 })] }));
        expect(hook.getCurrent()?.ready).toBe(true);
        expect(hook.getCurrent()?.phase).toBe('ready');
        expect(hook.getCurrent()?.readyProject).toEqual(preparedResult);
        expect(onReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: batch.selection.repositories[0]!.source }));
        act(() => actionOperationStore.setMachineObservation(query, 'reconnecting'));
        act(() => actionOperationStore.setMachineObservation(query, 'available'));
        expect(onReady).toHaveBeenCalledTimes(1);
        await hook.unmount();
        const reopened = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(reopened.getCurrent()?.ready).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
        await reopened.unmount();
    });
    it('does not announce an old terminal summary when its native full result hydrates', async () => {
        const full = createDeferred<unknown>();
        daemonReply.mockReturnValue(full.promise);
        const batch = selectedBatch();
        const onReady = vi.fn();
        const summary = opening({ requestId: 'selected-request', state: 'succeeded', settledAt: 2 });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [summary] }));
        const hook = await renderHook(() => ({
            row: useTeamSetupBatchProgress(batch, 'source', onReady),
            task: useTeamSetupBatchProgress(batch, 'source', undefined, { observeOpen: false }),
        }));
        expect(hook.getCurrent().row?.ready).toBe(false);
        expect(hook.getCurrent().task?.readyProject).toBeNull();
        await vi.waitFor(() => expect(daemonReply).toHaveBeenCalledTimes(1));
        full.resolve({ kind: 'found', operation: { ...summary, result: { ...preparedResult, setup: 'notRequired' } } });
        await vi.waitFor(() => expect(hook.getCurrent().task?.readyProject).toEqual({ ...preparedResult, setup: 'notRequired' }));
        expect(hook.getCurrent().row?.ready).toBe(true);
        expect(daemonReply).toHaveBeenCalledTimes(1);
        expect(onReady).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('does not replay completion received through reconnect', async () => {
        daemonReply.mockReturnValue(new Promise(() => {}));
        const batch = selectedBatch();
        const onReady = vi.fn();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [opening({ requestId: 'selected-request' })] }));
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        act(() => actionOperationStore.setMachineObservation(query, 'reconnecting'));
        expect(hook.getCurrent()?.phase).toBe('unavailable');
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ requestId: 'selected-request', revision: 2, state: 'succeeded', settledAt: 2,
                result: { ...preparedResult, setup: 'notRequired' } })] }));
        act(() => actionOperationStore.setMachineObservation(query, 'available'));
        expect(hook.getCurrent()?.ready).toBe(true);
        expect(onReady).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it.each([
        { machine: { ok: true as const, result: { kind: 'approval_request_created' as const, artifactId: 'approval', actionId: 'machines.setup.apply' as const } }, phase: 'approval' },
        { machine: null, phase: 'stopped' },
    ])('leaves undispatched selection $phase when its native prerequisite stops the runner', async ({ machine, phase }) => {
        const batch: TeamSetupBatch = { ...selectedBatch(), running: false, settlement: {
            completed: false, machine, machineSettlement: null, repositories: [],
        } };
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'next'));
        expect(hook.getCurrent()).toMatchObject({ phase, queued: false, ready: false });
        await hook.unmount();
    });
    it('announces a locally dispatched native no-setup completion once, without replay on reopening', async () => {
        daemonReply.mockReturnValue(new Promise(() => {}));
        let batch: TeamSetupBatch | null = null;
        const onReady = vi.fn();
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        batch = selectedBatch();
        await hook.rerender();
        batch = { ...batch, running: false, settlement: { completed: true, machine: null, machineSettlement: null, repositories: [
            { id: 'source', result: { ok: true, result: { ...preparedResult, setup: 'notRequired' } } },
        ] } };
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ phase: 'ready', ready: true });
        expect(onReady).toHaveBeenCalledTimes(1);
        await hook.unmount();
        const reopened = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(reopened.getCurrent()?.ready).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
        await reopened.unmount();
    });
});
describe('Team repository setup progress', () => {
    it('joins only the selected native request on the exact Source and target', async () => {
        const discovery = createDeferred<unknown>();
        daemonReply.mockReturnValue(new Promise(() => {})).mockReturnValueOnce(discovery.promise);
        const selectedQuery = { ...query, requestId: 'selected-request' };
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ operationId: 'previous-open', requestId: 'previous-request', state: 'succeeded', settledAt: 2,
                result: { kind: 'opened', setup: 'notRequired', directory: '/old',
                    workspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'old', rootPath: '/old' } } })] }));
        const hook = await renderHook(() => useTeamSetupRepositoryProgress(selectedQuery, lifetime));
        expect(hook.getCurrent().openOperation).toBeNull();
        await vi.waitFor(() => expect(daemonRequests).toContainEqual(expect.objectContaining({
            method: expect.stringContaining(`${query.machineId}:`),
            params: { requestIdentity: { actionId: 'projects.open', requestId: 'selected-request' } },
        })));
        discovery.resolve({ items: [opening({ operationId: 'selected-open', requestId: 'selected-request', createdAt: 3 })], nextCursor: null });
        await vi.waitFor(() => expect(hook.getCurrent().openOperation?.snapshot.operationId).toBe('selected-open'));
        // The first matching snapshot joins this same observer instead of starting an operation-id reader too.
        await vi.waitFor(() => expect(daemonReply).toHaveBeenCalledTimes(2));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [
            opening({ operationId: 'concurrent-open', requestId: 'other-request', createdAt: 4 }),
            opening({ operationId: 'wrong-target', requestId: 'selected-request', createdAt: 5,
                scope: { accountId: query.accountId, machineId: 'other-machine' } }),
        ] }));
        expect(hook.getCurrent().openOperation?.snapshot.operationId).toBe('selected-open');
        await hook.unmount();
    });
    it('observes in-flight Open before its checkout exists, then rejoins its full result and pushed setup after navigation', async () => {
        const terminal = createDeferred<unknown>();
        daemonReply.mockReturnValue(terminal.promise);
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [opening()] }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useTeamSetupRepositoryProgress(query, lifetime); });
        expect(hook.getCurrent()).toMatchObject({ openOperation: { snapshot: { state: 'running' } }, result: null, setupOperation: null });
        await vi.waitFor(() => expect(daemonReply).toHaveBeenCalledTimes(1));
        const before = renders;
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [
            opening({ operationId: 'foreign-account', createdAt: 20, scope: { accountId: 'other', machineId: 'member-machine' } }),
            opening({ operationId: 'foreign-machine', createdAt: 30, scope: { accountId: 'member', machineId: 'other' } }),
            opening({ operationId: 'foreign-source', createdAt: 40, domainRef: { kind: 'projectOpen', sourceId: 'other' } }),
        ] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [opening({ createdAt: 50 })] }));
        expect(renders).toBe(before);
        await hook.unmount();
        const summary = opening({ revision: 2, state: 'succeeded', settledAt: 10 });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [summary] }));
        const opened = OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'prepared', directory: '/repo',
            workspace: { serverId: query.serverId, machineId: 'member-machine', workspaceId: 'repo', rootPath: '/repo' } });
        daemonReply.mockResolvedValue({ kind: 'found', operation: { ...summary, result: opened } });
        const reopened = await renderHook(() => useTeamSetupRepositoryProgress(query, lifetime));
        await vi.waitFor(() => expect(reopened.getCurrent().result).toEqual(opened));
        const setup = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'setup', revision: 1,
            actionId: 'projects.prepare', state: 'running', scope: { accountId: 'member', machineId: 'member-machine' },
            title: 'Prepare', createdAt: 11, startedAt: 11, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: query.serverId, machineId: 'member-machine',
                workspaceRefId: 'repo', cwd: '/repo', sourceWorkspace: opened.kind === 'opened' && 'machineId' in opened.workspace ? opened.workspace : undefined } });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setup] }));
        expect(reopened.getCurrent().setupOperation?.snapshot.state).toBe('running');
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [{ ...setup, revision: 2,
            state: 'failed', settledAt: 12, error: { errorCode: 'setup_exit_nonzero', error: 'Setup failed' } }] }));
        expect(reopened.getCurrent().setupOperation?.snapshot).toMatchObject({ state: 'failed', error: { errorCode: 'setup_exit_nonzero' } });
        expect(reopened.getCurrent().result).toEqual(opened);
        await reopened.unmount();
    });
    it.each([
        { kind: 'refused', code: 'destination_exists', effectAttempted: false },
        { kind: 'outcomeUnknown', operationId: 'open' },
        { kind: 'opened', setup: 'failed', directory: '/repo', workspace: { serverId: query.serverId, machineId: 'member-machine', workspaceId: 'repo', rootPath: '/repo' } },
    ])('preserves the canonical $kind result without inventing readiness', async value => {
        const result = OpenProjectResultV1Schema.parse({ ...value,
            ...('workspace' in value ? { workspace: { ...value.workspace, serverId: query.serverId } } : {}) });
        daemonReply.mockReturnValue(new Promise(() => {}));
        const outcome = result.kind === 'refused'
            ? { state: 'failed' as const, settledAt: 2, error: { errorCode: result.code, error: result.code } }
            : result.kind === 'outcomeUnknown'
                ? { observation: { kind: 'outcome_uncertain' as const, code: 'action_outcome_unknown' } }
                : { state: 'succeeded' as const, settledAt: 2 };
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ ...outcome, result })] }));
        const hook = await renderHook(() => useTeamSetupRepositoryProgress(query, lifetime));
        expect(hook.getCurrent()).toMatchObject({ result, setupOperation: null });
        await hook.unmount();
    });
});
