import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { parseToken } from '@/utils/auth/parseToken';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

const inspectionTransport = vi.hoisted(() => ({ accounts: [] as string[], answer: null as unknown,
    workerAnswer: null as unknown, hold: null as Promise<void> | null }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// The encrypted daemon RPC transport is external. Admission/Actions/client/parsers remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ method: string; accountId?: string | null }>) => {
        if (request.method === 'projects.worker.status' && inspectionTransport.workerAnswer) return inspectionTransport.workerAnswer;
        if (request.method !== 'daemon.projects.inspect.v1') throw new Error(`Unexpected Script RPC: ${request.method}`);
        inspectionTransport.accounts.push(request.accountId ?? '');
        const answer = inspectionTransport.answer;
        await inspectionTransport.hold;
        return answer;
    },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Genuine platform/text boundaries; authenticated scope, operation store and selectors stay real.
installSessionSubagentCommonModuleMocks({ storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage') });
installDisconnectedServerSocketBoundary();
// Load credential ownership only after the shared platform harness is configured for real storage.
// Its connection graph otherwise reaches the harness's default internal stub during static imports.
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useProjectScriptRun, useProjectSetupRun } = await import('./projectScriptRuns');
const { useProjectDefinitionInspection } = await import('./useProjectDefinitionInspection');
const { useProjectScriptsController } = await import('./useProjectScriptsController');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const NO_CHANGE = () => {};
afterEach(() => { standardCleanup(); actionOperationStore.reset(); inspectionTransport.accounts = []; inspectionTransport.answer = null;
    inspectionTransport.workerAnswer = null; inspectionTransport.hold = null; });

describe('Scripts canonical operation subscriptions', () => {
    it.each([
        { delivery: 'direct', reason: 'not_accepting' }, { delivery: 'approved', reason: 'not_accepting' },
        { delivery: 'direct', reason: 'worker_copy_missing' }, { delivery: 'approved', reason: 'worker_copy_missing' },
    ] as const)('retains typed no-worker fallback facts without accepting or automatically running on primary ($delivery, $reason)', async ({ delivery, reason }) => {
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const dispatched: unknown[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account', encryptionMode: 'plain' });
        const serverIdentityId = delivery === 'direct' ? 'srv_script_worker_refusal' : 'srv_script_worker_refusal_approved';
        const actionSettings = { actionsSettingsV1: { v: 1, actions: {
            'projects.script.run': { approvalRequiredSurfaces: delivery === 'approved' ? ['ui'] : [] },
        } } };
        const refusalCode = reason === 'worker_copy_missing' ? reason : 'choice_required';
        const targetMachineId = reason === 'worker_copy_missing' ? 'worker-machine' : 'source-machine';
        const connection = await restoreServerAccountForTest({
            serverUrl: delivery === 'direct' ? 'https://script-worker-refusal.test' : 'https://script-worker-refusal-approved.test',
            serverIdentityId, accountId: 'account',
            credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/machines') return Response.json([...new Set(['source-machine', targetMachineId])]
                    .map(id => createPlainMachineRowFixture({ id, accountId: 'account' })));
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: actionSettings }, version: 1 });
                if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { enabled: true, destination: { kind: 'machine', machineId: targetMachineId },
                        unavailable: 'primary', allowAdHoc: false, scriptOverrides: {}, services: {} } } });
                if (path === '/v1/actions/projects.script.run/execution-authorization') {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
                    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(request.envelope.input);
                    const machine = createPlainMachineRowFixture({ id: input.choice?.kind === 'workers' ? targetMachineId : 'source-machine', accountId: 'account' });
                    expect(request.machineId).toBe(machine.id);
                    return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-script-home-root', binding: {
                        accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
                        machineId: machine.id, installationId: machine.installationId, custodianAccountId: 'account', accountEncryptionMode: 'plain',
                        actionId: 'projects.script.run', requestId: request.envelope.requestId, target: request.envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                    } }));
                }
                if (path === '/v1/actions/projects.script.run') {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(envelope.input);
                    expect(request.executionAuthorization?.binding).toMatchObject({ machineId: input.choice?.kind === 'workers' ? targetMachineId : 'source-machine',
                        accountId: 'account', custodianAccountId: 'account', actionId: 'projects.script.run' });
                    dispatched.push(envelope.input);
                    return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.script.run', requestId: envelope.requestId,
                        // Refusals never dispatch. A later explicit intent addresses its exact
                        // Machine while the canonical input retains the original SOURCE.
                        execution: { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } }));
                }
                return await artifacts.handle(path, init) ?? Response.json({}, { status: 404 });
            },
        });
        let unmountHook: (() => Promise<void>) | undefined;
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id),
                machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
            const workerRefusal = { kind: 'no_worker_can_accept' as const, unavailable: 'primary' as const, reason,
                ...(reason === 'worker_copy_missing' ? { workerCopy: { serverId: workspace.serverId,
                    sourceWorkspaceRefId: workspace.workspaceId, sourceMachineId: workspace.machineId, targetMachineId } } : {}) };
            // Publish the same Account policy as its HTTP baseline through the real settings owner.
            // Focused-Home reads legitimately use this applied projection instead of refetching it.
            const { storage } = await import('@/sync/domains/state/storage');
            const { settingsParse } = await import('@/sync/domains/settings/settings');
            storage.getState().applySettingsForScope({ serverId: workspace.serverId, accountId: 'account' }, settingsParse(actionSettings), 1);
            expect(storage.getState().settings).toMatchObject(actionSettings);
            const manifest = { version: 1, scripts: { build: { source: { kind: 'command', command: 'build' }, execution: 'portable' } } };
            inspectionTransport.answer = { definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: { status: 'valid',
                bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
                detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] };
            inspectionTransport.workerAnswer = ProjectWorkerStatusResultV1Schema.parse({ eligible: false, candidate: null,
                load: { kind: 'unknown' }, explanation: reason,
                ...(workerRefusal.workerCopy ? { workerCopy: workerRefusal.workerCopy } : {}) });
            const homes = [workspace.serverId];
            const onChanged = vi.fn();
            const hook = await renderHook(() => {
                const binding = useServerCredentialAccountScopeBindings(homes).get(workspace.serverId) ?? null;
                return useProjectScriptsController(workspace, onChanged, binding);
            });
            unmountHook = hook.unmount;
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            if (delivery === 'approved') {
                // The product creates and settles this Artifact. No terminal record or approval
                // authority is assembled here: Inbox approval replays the original missing choice.
                let pendingRun: Promise<void> | undefined;
                act(() => { pendingRun = hook.getCurrent().run('build', { kind: 'named', name: 'build' }); });
                await vi.waitFor(() => expect(hook.getCurrent().approvalId).not.toBeNull());
                const approvalId = hook.getCurrent().approvalId;
                if (!approvalId) throw new Error('Expected the real Script approval');
                expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(approvalId) ?? 'null'))).toMatchObject({
                    status: 'open', actionId: 'projects.script.run', actionArgs: { workspace, selection: { kind: 'named', name: 'build' } },
                });
                expect(hook.getCurrent().pendingKeys.build).toBe(true);
                expect(hook.getCurrent().failure).toBeNull();
                expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
                expect(dispatched).toEqual([]);
                await act(async () => {
                    await expect(decideApprovalAsInbox(workspace.serverId, approvalId, 'approve')).resolves.toMatchObject({
                        ok: true, result: { status: 'failed' },
                    });
                });
                expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(approvalId) ?? 'null'))).toMatchObject({
                    status: 'failed', execution: { ok: false, errorCode: refusalCode, details: workerRefusal },
                });
                await vi.waitFor(() => expect(hook.getCurrent().failure).toMatchObject({ key: 'build', code: refusalCode, workerRefusal }));
                await act(async () => { await pendingRun; });
            } else {
                await act(async () => { await hook.getCurrent().run('build', { kind: 'named', name: 'build' }); });
            }
            expect(hook.getCurrent().failure).toMatchObject({ key: 'build', code: refusalCode });
            expect(hook.getCurrent().failure).toMatchObject({ workerRefusal });
            expect(hook.getCurrent().pendingKeys.build).toBeUndefined();
            expect(hook.getCurrent().consent).toBeNull();
            expect(hook.getCurrent().approvalId).toBeNull();
            expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
            expect(dispatched).toEqual([]);
            expect(onChanged).not.toHaveBeenCalled();
            if (delivery === 'direct') {
                // This is renewed explicit user intent, not an automatic fallback after the refusal.
                await act(async () => { await hook.getCurrent().run('build', { kind: 'named', name: 'build' }, { kind: 'primary' }); });
                expect(dispatched).toEqual([{ workspace, selection: { kind: 'named', name: 'build' }, choice: { kind: 'primary' } }]);
                expect(hook.getCurrent().failure).toEqual({ key: 'build', code: 'permission_denied' });
                if (reason === 'worker_copy_missing') {
                    // Sync's committed setup makes the target observable as eligible. A changed
                    // census is not renewed Run intent and must not replay the refused request.
                    inspectionTransport.workerAnswer = ProjectWorkerStatusResultV1Schema.parse({
                        eligible: true, candidate: { serverId: workspace.serverId, machineId: targetMachineId },
                        load: { kind: 'unknown' }, explanation: 'load_unknown', lastCleanSyncAtMs: 2_000,
                    });
                    await act(async () => {});
                    expect(dispatched).toHaveLength(1);
                    const choice: ProjectExecutionChoiceV1 = { kind: 'workers', destination: { kind: 'machine', machineId: targetMachineId } };
                    await act(async () => { await hook.getCurrent().run('build', { kind: 'named', name: 'build' }, choice); });
                    expect(hook.getCurrent().failure).toEqual({ key: 'build', code: 'permission_denied' });
                    expect(dispatched).toEqual([
                        { workspace, selection: { kind: 'named', name: 'build' }, choice: { kind: 'primary' } },
                        { workspace, selection: { kind: 'named', name: 'build' }, choice },
                    ]);
                }
            }
            expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
        } finally {
            try { await unmountHook?.(); }
            finally { await connection.dispose(); disposeExecutor(); }
        }
    });
    it('opens the qualified retained Script detail and output after Activity dismissal without restoring its Activity row', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://script-retained-detail.test', serverIdentityId: 'srv_script_retained_detail', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        try {
            const serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
            const workspace = { serverId, machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
            actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ version: 1, operationId: 'retained-script', revision: 2,
                actionId: 'projects.script.run', state: 'succeeded', scope: { accountId: 'account', machineId: 'source-machine' },
                title: 'Retained build', createdAt: 100, startedAt: 110, settledAt: 150, cancellation: 'unsupported',
                domainRef: { kind: 'projectCommand', purpose: 'script', serverId, machineId: 'source-machine',
                    workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace,
                    script: { name: 'build', source: { kind: 'command', command: 'build' } }, terminalId: 'retained-terminal' } }] });
            actionOperationStore.dismissRecentSucceeded();
            const { createActionOperationSelectors } = await import('@/sync/domains/actionOperations/actionOperationSelectors');
            const selectors = createActionOperationSelectors();
            expect(selectors.selectAll(actionOperationStore.getSnapshot())).toEqual([]);
            const { ActionOperationDetailModal } = await import('@/components/inbox/actionOperations/ActionOperationDetailModal');
            const setChrome = vi.fn();
            const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId="retained-script"
                onClose={NO_CHANGE} setChrome={setChrome} />);
            expect(setChrome.mock.calls.at(-1)?.[0]?.title).toBe('Retained build');
            expect(screen.findByTestId('project-command-output')).not.toBeNull();
            expect(selectors.selectAll(actionOperationStore.getSnapshot())).toEqual([]);
            await screen.unmount();
        } finally { await connection.dispose(); }
    });
    it('withdraws the previous Account definition and aborts its late read before using the replacement Account client', async () => {
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://script-definition-scope.test', serverIdentityId: 'srv_script_definition_scope', accountId: 'account',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/machines') {
                    const bearer = new Headers(init?.headers).get('Authorization')?.slice('Bearer '.length);
                    if (!bearer) throw new Error('Machine census must carry its captured Account');
                    return Response.json([createPlainMachineRowFixture({ id: 'source-machine', accountId: parseToken(bearer) })]);
                }
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const lateRead = createDeferred<void>();
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
            const answerFor = (command: string) => {
                const manifest = { version: 1 as const, scripts: { build: { source: { kind: 'command' as const, command } } } };
                return { definition: { basis: { kind: 'present' as const, hash: 'a'.repeat(64) }, document: { status: 'valid' as const,
                    bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
                    detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete' as const, diagnostics: [] }, importCandidates: [] };
            };
            inspectionTransport.answer = answerFor('previous-account-command');
            const homes = [workspace.serverId];
            const hook = await renderHook(() => {
                const bindings = useServerCredentialAccountScopeBindings(homes);
                const binding = bindings.get(workspace.serverId) ?? null;
                return useProjectDefinitionInspection(workspace, binding);
            });
            await vi.waitFor(() => {
                const read = hook.getCurrent().read;
                expect(read).not.toBeNull();
                expect(read && 'error' in read ? read.error : null, `Initial inspection; RPC Accounts: ${inspectionTransport.accounts.join(',')}`).toBeNull();
                expect(read).toMatchObject({ value: { definition: { document: { manifest: { scripts: { build: { source: { command: 'previous-account-command' } } } } } } } });
            });
            inspectionTransport.hold = lateRead.promise;
            await act(async () => { hook.getCurrent().retry(); });
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account']));
            inspectionTransport.answer = answerFor('replacement-account-command');
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'next-account' })).toString('base64url')}.signature` };
            vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(credentials);
            await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, credentials); });
            expect(hook.getCurrent().read).toBeNull();
            await vi.waitFor(() => expect(inspectionTransport.accounts).toContain('next-account'));
            inspectionTransport.hold = null;
            lateRead.resolve();
            await vi.waitFor(() => expect(hook.getCurrent().read).toMatchObject({ value: { definition: { document: { manifest: { scripts: { build: { source: { command: 'replacement-account-command' } } } } } } } }));
            await hook.unmount();
        } finally { lateRead.resolve(); await connection.dispose(); disposeExecutor(); }
    });

    it('shows another client\'s accepted Script before launch, keeps its dismissed completion, and retires disclosure with Account', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://script-source.test', serverIdentityId: 'srv_script_source', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
            const snapshot: ActionOperationSnapshotV1 = {
                version: 1, operationId: 'external-script', revision: 1, actionId: 'projects.script.run', state: 'accepted',
                scope: { accountId: 'account', machineId: 'custody-machine' }, title: 'Build', createdAt: 100, cancellation: 'supported',
                domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'execution-home', machineId: 'execution-machine',
                    workspaceRefId: 'execution-workspace', cwd: '/execution', sourceWorkspace: workspace,
                    script: { name: 'build', source: { kind: 'command', command: 'build-command' } } },
            };
            actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [snapshot] });
            expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(1);
            const homes = [workspace.serverId];
            const hook = await renderHook(() => {
                const binding = useServerCredentialAccountScopeBindings(homes).get(workspace.serverId) ?? null;
                const controller = useProjectScriptsController(workspace, NO_CHANGE, binding);
                // A registered client-local profile alias refers to the same admitted Home.
                return useProjectScriptRun({ ...workspace, serverId: connection.home.id }, { kind: 'named', name: 'build' }, controller.accountId);
            });
            await vi.waitFor(() => expect(hook.getCurrent()?.snapshot.operationId).toBe('external-script'));
            expect(hook.getCurrent()?.snapshot.operationId).toBe('external-script');
            const selected = hook.getCurrent();
            await act(async () => { actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [{ ...snapshot, operationId: 'unrelated' }] }); });
            expect(hook.getCurrent()).toBe(selected);
            if (snapshot.domainRef?.kind !== 'projectCommand') throw new Error('Missing command fixture');
            const terminal: ActionOperationSnapshotV1 = { ...snapshot, revision: 2, state: 'succeeded', startedAt: 110, settledAt: 150,
                domainRef: { ...snapshot.domainRef, kind: 'projectCommand', purpose: 'script', terminalId: 'terminal',
                    serverId: 'execution-home', machineId: 'execution-machine', workspaceRefId: 'execution-workspace', cwd: '/execution' } };
            await act(async () => { actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [terminal] }); actionOperationStore.dismissRecentSucceeded(); });
            expect(hook.getCurrent()?.snapshot.state).toBe('succeeded');
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const nextCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'next-account' })).toString('base64url')}.signature` };
            vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(nextCredentials);
            await act(async () => { expect(await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, nextCredentials)).toBe(true); });
            await vi.waitFor(() => expect(hook.getCurrent()).toBeNull());
            await act(async () => { actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [{ ...snapshot, operationId: 'replacement-script', scope: { ...snapshot.scope, accountId: 'next-account' } }] }); });
            await vi.waitFor(() => expect(hook.getCurrent()?.snapshot.operationId).toBe('replacement-script'));
            await hook.unmount();
        } finally { await connection.dispose(); }
    });

    it('selects standalone preparation by Source without borrowing a Script\'s setup phase or another Account', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://setup-source.test', serverIdentityId: 'srv_setup_source', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
            const setup: ActionOperationSnapshotV1 = { version: 1, operationId: 'standalone', revision: 1, actionId: 'projects.prepare', state: 'accepted',
                scope: { accountId: 'account', machineId: 'custody-machine' }, title: 'Prepare', createdAt: 100, cancellation: 'supported',
                domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'execution-home', machineId: 'execution-machine', workspaceRefId: 'execution-workspace', cwd: '/execution', sourceWorkspace: workspace } };
            const attachment = setup.domainRef;
            if (attachment?.kind !== 'projectCommand') throw new Error('Missing preparation fixture');
            actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [setup,
                { ...setup, operationId: 'script-setup', actionId: 'projects.script.run', createdAt: 200, domainRef: { ...attachment, kind: 'projectCommand', purpose: 'setup', serverId: workspace.serverId,
                    machineId: workspace.machineId, workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, script: { name: 'build', source: { kind: 'command', command: 'build' } } } },
                { ...setup, operationId: 'foreign-account', createdAt: 300, scope: { ...setup.scope, accountId: 'other' } },
            ] });
            expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(3);
            const homes = [workspace.serverId];
            const hook = await renderHook(() => {
                const binding = useServerCredentialAccountScopeBindings(homes).get(workspace.serverId) ?? null;
                return useProjectSetupRun({ ...workspace, serverId: connection.home.id }, binding?.isCurrent() ? binding.accountId : null);
            });
            await vi.waitFor(() => expect(hook.getCurrent()?.snapshot.operationId).toBe('standalone'));
            await hook.unmount();
        } finally { await connection.dispose(); }
    });
});
