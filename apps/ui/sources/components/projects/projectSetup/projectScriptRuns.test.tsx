import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
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
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { parseToken } from '@/utils/auth/parseToken';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS, ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ProjectManifestFileSnapshotSchema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';

const inspectionTransport = vi.hoisted(() => ({ accounts: [] as string[], reads: [] as unknown[], answer: null as unknown,
    workerAnswer: null as unknown, hold: null as Promise<void> | null, failure: null as string | null, offline: false }));

// Passive inspection uses the original Account's external Action ingress even on its own Machine.
async function inspectActionResponse(path: string, init?: RequestInit): Promise<Response | null> {
    if (path !== '/v1/actions/projects.inspect') return null;
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    const request = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS['projects.inspect'].parse(envelope.input);
    inspectionTransport.reads.push(request.read);
    expect(envelope.target).toEqual({ kind: 'machine', machineId: request.workspace.machineId });
    const bearer = new Headers(init?.headers).get('Authorization')?.slice('Bearer '.length);
    if (!bearer) throw new Error('Inspection must carry its captured Account');
    inspectionTransport.accounts.push(parseToken(bearer));
    if (inspectionTransport.offline) throw new TypeError('Network request failed');
    if (inspectionTransport.failure) return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
        requestId: envelope.requestId, execution: { ok: false, errorCode: inspectionTransport.failure, error: inspectionTransport.failure } }));
    const answer = ProjectDefinitionInspectOutputSchema.parse(inspectionTransport.answer);
    await inspectionTransport.hold;
    return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.inspect',
        requestId: envelope.requestId, execution: { ok: true, result: answer } }));
}
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
const { useProjectDefinitionInspection, projectDefinitionInspectionKey } = await import('./useProjectDefinitionInspection');
const { useProjectScriptsController } = await import('./useProjectScriptsController');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const NO_CHANGE = () => {};
afterEach(() => { standardCleanup(); actionOperationStore.reset(); inspectionTransport.accounts = []; inspectionTransport.answer = null;
    inspectionTransport.reads = [];
    inspectionTransport.workerAnswer = null; inspectionTransport.hold = null; inspectionTransport.failure = null; inspectionTransport.offline = false; });

describe('Scripts canonical operation subscriptions', () => {
    it('refreshes consumed readiness on a Project operation change without rereading an open editor', async () => {
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://script-readiness-demand.test', serverIdentityId: 'srv_script_readiness_demand', accountId: 'account',
            credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const inspection = await inspectActionResponse(path, init);
                if (inspection) return inspection;
                const machineRead = createPlainMachineReadHttpResponseFixture(path, init, 'account');
                if (machineRead) return machineRead;
                if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'source-machine', accountId: 'account' })]);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id),
                machineId: 'source-machine', workspaceId: 'source', rootPath: '/source' };
            const manifest = { version: 1 as const, workspace: { setup: [{ kind: 'command' as const, command: 'echo setup' }] } };
            const answer = { definition: { basis: { kind: 'present' as const, hash: 'a'.repeat(64) },
                document: { status: 'valid' as const, bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
                detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete' as const, diagnostics: [] }, importCandidates: [] };
            inspectionTransport.answer = { ...answer, setupReadiness: { kind: 'unprepared', reviewedEffectDigest: 'effect' } };
            const homes = [workspace.serverId];
            const scripts = await renderHook(() => {
                const binding = useServerCredentialAccountScopeBindings(homes).get(workspace.serverId) ?? null;
                return { ...useProjectDefinitionInspection(workspace, binding, { kind: 'scripts' }), binding };
            });
            await vi.waitFor(() => expect(scripts.getCurrent().read).toHaveProperty('value'));
            const editor = await renderHook(() => useProjectDefinitionInspection(workspace, scripts.getCurrent().binding, { kind: 'editor' }));
            await vi.waitFor(() => expect(editor.getCurrent().read).toHaveProperty('value'));
            const readCount = (kind: string) => inspectionTransport.reads.filter(read => read && typeof read === 'object' && 'kind' in read && read.kind === kind).length;
            expect(readCount('scripts')).toBe(1);
            expect(readCount('editor')).toBe(1);
            inspectionTransport.answer = { ...answer, setupReadiness: { kind: 'current', reviewedEffectDigest: 'effect', completedAtMs: 123 } };
            const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'readiness-control', revision: 1,
                actionId: 'projects.prepare', state: 'succeeded', scope: { accountId: 'account', machineId: workspace.machineId },
                title: 'Prepare', createdAt: 100, startedAt: 110, settledAt: 120, cancellation: 'unsupported',
                domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: workspace.serverId, machineId: workspace.machineId,
                    workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace } };
            await act(async () => { actionOperationStore.mergeSnapshots({ serverId: workspace.serverId, snapshots: [operation] }); });
            await vi.waitFor(() => expect(scripts.getCurrent().read).toMatchObject({ value: { setupReadiness: { kind: 'current', completedAtMs: 123 } } }));
            expect(readCount('scripts')).toBe(2);
            expect(readCount('editor')).toBe(1);
            await act(async () => { editor.getCurrent().retry(); });
            await vi.waitFor(() => expect(readCount('editor')).toBe(2));
            await editor.unmount();
            await scripts.unmount();
        } finally { await connection.dispose(); disposeExecutor(); }
    });
    it.each([false, true])('shares demanded inspection and releases its full tree on last close before fresh reopen (initially presented: %s)', async initiallyPresented => {
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://script-definition-demand.test', serverIdentityId: 'srv_script_definition_demand', accountId: 'account',
            credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const inspection = await inspectActionResponse(path, init);
                if (inspection) return inspection;
                const machineRead = createPlainMachineReadHttpResponseFixture(path, init, 'account');
                if (machineRead) return machineRead;
                if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'source-machine', accountId: 'account' })]);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const refreshing = createDeferred<void>();
        let presented = initiallyPresented;
        const wrapper = ({ children }: React.PropsWithChildren) => <PluginSurfaceFocusEligibilityProvider active={presented}>{children}</PluginSurfaceFocusEligibilityProvider>;
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), machineId: 'source-machine', workspaceId: 'source', rootPath: '/source' };
            const native = { kind: 'native', tool: 'package_script', file: 'package.json', target: 'build' };
            const manifest = { version: 1, scripts: { build: { source: native } },
                services: { app: { source: { kind: 'command', command: 'serve' }, execution: 'portable' } } };
            inspectionTransport.answer = ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'present', hash: 'a'.repeat(64) },
                document: { status: 'valid', bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
                // The observed FX220 checkout had 6,230 detected entries; closing must release that shape too.
                detection: { entries: Array.from({ length: 6_230 }, (_, index) => ({ source: { ...native, target: `build-${index}` }, usage: 'script' })),
                    toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
                setupReadiness: { kind: 'current', reviewedEffectDigest: 'inspected-effect', completedAtMs: 123 },
                setupConsent: { kind: 'admitted' } });
            const homes = [workspace.serverId];
            const useInspection = () => {
                const binding = useServerCredentialAccountScopeBindings(homes).get(workspace.serverId) ?? null;
                return { ...useProjectDefinitionInspection(workspace, binding), binding };
            };
            const hook = await renderHook(useInspection, { wrapper });
            if (initiallyPresented) await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account']));
            expect(inspectionTransport.accounts).toEqual(initiallyPresented ? ['account'] : []);
            presented = true;
            await hook.rerender();
            await vi.waitFor(() => expect(hook.getCurrent().read).toHaveProperty('value'));
            const success = hook.getCurrent().read;
            if (!success || !('value' in success)) throw new Error('Expected admitted inspection');
            expect(success.value.detection.entries).toHaveLength(6_230);
            const { createProjectManifestEditorModel } = await import('./projectManifestEditorModel');
            const { createProjectManifestActionClient } = await import('./projectManifestActionClient');
            const actions = createProjectManifestActionClient({ workspace, expectedAccountId: 'account' });
            const draft = createProjectManifestEditorModel({ workspace, expectedAccountId: 'account',
                definition: ProjectManifestFileSnapshotSchema.parse(success.value.definition), actions });
            const dirtyBytes = JSON.stringify({ ...manifest, scripts: { edited: { source: { kind: 'command', command: 'keep my draft' } } } });
            draft.setRaw(dirtyBytes);
            const mainBinding = hook.getCurrent().binding;
            expect(inspectionTransport.accounts).toEqual(['account']);
            const sibling = await renderHook(useInspection, { wrapper });
            await vi.waitFor(() => expect(sibling.getCurrent().read).toHaveProperty('value'));
            expect(inspectionTransport.accounts).toEqual(['account']);
            expect(sibling.getCurrent().read).toBe(success);
            await sibling.unmount();
            expect(hook.getCurrent().read).toBe(success);
            // Two children can also consume one parent-owned binding. Releasing one
            // must not withdraw the other's remaining demand or currentness.
            const sameBinding = await renderHook(() => useProjectDefinitionInspection(workspace, mainBinding), { wrapper });
            expect(inspectionTransport.accounts).toEqual(['account']);
            await sameBinding.unmount();
            await act(async () => { hook.getCurrent().retry(); });
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account']));
            presented = false;
            await hook.rerender();
            // No retained inspection tree after the last visible consumer leaves.
            expect(hook.getCurrent().read).toBeNull();
            await act(async () => { hook.getCurrent().retry(); });
            expect(inspectionTransport.accounts).toEqual(['account', 'account']);
            inspectionTransport.hold = refreshing.promise;
            // A new presented consumer may reopen while the old hook remains mounted but hidden. The
            // narrow Scripts list paints at once as last-good, its setup facts at full strength while it revalidates.
            const replacement = await renderHook(() => useProjectDefinitionInspection(workspace, mainBinding));
            const lastGood = replacement.getCurrent().read;
            expect(lastGood).toMatchObject({ refreshing: true });
            if (!lastGood || !('value' in lastGood)) throw new Error('Expected the retained Scripts list');
            expect(lastGood.value.detection).toBe(success.value.detection);
            expect(lastGood.value).toBe(success.value);
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account', 'account']));
            presented = true;
            await hook.rerender();
            expect(hook.getCurrent().read).toBe(lastGood);
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account', 'account']));
            await act(async () => { refreshing.resolve(); });
            await vi.waitFor(() => expect(hook.getCurrent().read).toMatchObject({ refreshing: false }));
            expect(replacement.getCurrent().read).toBe(hook.getCurrent().read);
            expect(inspectionTransport.accounts).toHaveLength(3);
            await replacement.unmount();
            await hook.unmount();
            const nextRead = createDeferred<void>();
            inspectionTransport.hold = nextRead.promise;
            const remounted = await renderHook(useInspection, { wrapper });
            // Reopen shows the narrow last-good list while it reacquires current facts.
            expect(remounted.getCurrent().read).toMatchObject({ refreshing: true });
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account', 'account', 'account']));
            await act(async () => { nextRead.resolve(); });
            await vi.waitFor(() => expect(remounted.getCurrent().read).toEqual(success));
            const reopened = remounted.getCurrent().read;
            if (!reopened || !('value' in reopened)) throw new Error('Expected fresh inspection');
            const reopenedDraft = createProjectManifestEditorModel({ workspace, expectedAccountId: 'account',
                definition: ProjectManifestFileSnapshotSchema.parse(reopened.value.definition), actions });
            expect(reopenedDraft.getSnapshot()).toMatchObject({ dirty: true, draft: { bytes: dirtyBytes } });
            const retainedBinding = remounted.getCurrent().binding;
            inspectionTransport.offline = true;
            await act(async () => { remounted.getCurrent().retry(); });
            await vi.waitFor(() => expect(remounted.getCurrent().read).toMatchObject({ refreshing: false, error: expect.any(String) }));
            const offline = remounted.getCurrent().read;
            expect(offline).toMatchObject({ value: { definition: success.value.definition, detection: success.value.detection } });
            expect(offline && 'value' in offline ? offline.value : null).toMatchObject({
                setupReadiness: success.value.setupReadiness, setupConsent: success.value.setupConsent });
            inspectionTransport.offline = false;
            for (const code of ['access_denied', 'admission_unavailable', 'content_unavailable', 'permission_denied', 'not_authenticated']) {
                inspectionTransport.failure = null;
                await act(async () => { remounted.getCurrent().retry(); });
                await vi.waitFor(() => expect(remounted.getCurrent().read).toEqual(success));
                inspectionTransport.failure = code;
                await act(async () => { remounted.getCurrent().retry(); });
                await vi.waitFor(() => expect(remounted.getCurrent().read).toHaveProperty('error', code));
                expect.soft(remounted.getCurrent().read).toEqual({ key: projectDefinitionInspectionKey(workspace), error: code });
                expect(remounted.getCurrent().binding).toBe(retainedBinding);
                expect(retainedBinding?.isCurrent()).toBe(true);
            }
            inspectionTransport.failure = null;
            const beforeSetup = inspectionTransport.accounts.length;
            const setup = await renderHook(() => useProjectDefinitionInspection(workspace, retainedBinding, { kind: 'setup' }), { wrapper });
            await vi.waitFor(() => expect(setup.getCurrent().read).toHaveProperty('value'));
            expect(inspectionTransport.accounts).toHaveLength(beforeSetup + 1);
            expect(inspectionTransport.reads[0]).toEqual({ kind: 'scripts' });
            expect(inspectionTransport.reads.at(-1)).toEqual({ kind: 'setup' });
            const sameSetup = await renderHook(() => useProjectDefinitionInspection(workspace, retainedBinding, { kind: 'setup' }), { wrapper });
            expect(sameSetup.getCurrent().read).toBe(setup.getCurrent().read);
            expect(inspectionTransport.accounts).toHaveLength(beforeSetup + 1);
            await sameSetup.unmount();
            await setup.unmount();
            await remounted.unmount();
        } finally { refreshing.resolve(); await connection.dispose(); disposeExecutor(); }
    });
    it.each([
        { policy: 'direct', reason: 'not_accepting' }, { policy: 'ask-first', reason: 'not_accepting' },
        { policy: 'direct', reason: 'worker_copy_missing' }, { policy: 'ask-first', reason: 'worker_copy_missing' },
    ] as const)('retains typed no-worker fallback facts without approval, acceptance, or automatic primary execution ($policy, $reason)', async ({ policy, reason }) => {
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const dispatched: unknown[] = [];
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account', encryptionMode: 'plain' });
        const serverIdentityId = policy === 'direct' ? 'srv_script_worker_refusal' : 'srv_script_worker_refusal_ask_first';
        const actionSettings = { actionsSettingsV1: { v: 1, actions: {
            'projects.script.run': { approvalRequiredSurfaces: policy === 'ask-first' ? ['ui'] : [] },
        }, ...(policy === 'direct' ? { approvalWaivedSurfaces: { 'projects.script.run': ['ui'] } } : {}) } };
        const refusalCode = reason === 'worker_copy_missing' ? reason : 'choice_required';
        const targetMachineId = reason === 'worker_copy_missing' ? 'worker-machine' : 'source-machine';
        const connection = await restoreServerAccountForTest({
            serverUrl: policy === 'direct' ? 'https://script-worker-refusal.test' : 'https://script-worker-refusal-ask-first.test',
            serverIdentityId, accountId: 'account',
            credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const inspection = await inspectActionResponse(path, init);
                if (inspection) return inspection;
                const machineRead = createPlainMachineReadHttpResponseFixture(path, init, 'account');
                if (machineRead) return machineRead;
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
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
                    const input = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(envelope.input);
                    const machine = createPlainMachineRowFixture({ id: input.choice?.kind === 'workers' ? targetMachineId : 'source-machine', accountId: 'account' });
                    expect(request.machineId).toBe(machine.id);
                    return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-script-home-root', binding: {
                        accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
                        machineId: machine.id, installationId: machine.installationId, custodianAccountId: 'account', accountEncryptionMode: 'plain',
                        actionId: 'projects.script.run', requestId: request.envelope.requestId, target: request.envelope.target,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                        workspaceSyncAdmission: {
                            relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
                            sourceWorkspaceRefId: input.workspace.workspaceId,
                            source: { actorAccountId: 'account', custodianAccountId: 'account',
                                machineId: input.workspace.machineId,
                                installationId: createPlainMachineRowFixture({ id: input.workspace.machineId, accountId: 'account' }).installationId,
                                role: 'manage', encryptionMode: 'plain' },
                        },
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
                detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [] };
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
            // The real placement owner refuses before an unsigned proposal can create approval custody.
            await act(async () => { await hook.getCurrent().run('build', { kind: 'named', name: 'build' }); });
            expect(hook.getCurrent().failure).toMatchObject({ key: 'build', code: refusalCode });
            expect(hook.getCurrent().failure).toMatchObject({ workerRefusal });
            expect(hook.getCurrent().pendingKeys.build).toBeUndefined();
            expect(hook.getCurrent().consent).toBeNull();
            expect(hook.getCurrent().approvalId).toBeNull();
            expect(artifacts.list()).toEqual([]);
            expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
            expect(dispatched).toEqual([]);
            expect(onChanged).not.toHaveBeenCalled();
            if (policy === 'direct') {
                // This is renewed explicit user intent, not an automatic fallback after the refusal.
                await act(async () => { await hook.getCurrent().run('build', { kind: 'named', name: 'build' }, { kind: 'primary' }); });
                expect(hook.getCurrent().failure).toEqual({ key: 'build', code: 'permission_denied' });
                expect(dispatched).toEqual([{ workspace, selection: { kind: 'named', name: 'build' }, choice: { kind: 'primary' } }]);
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
            const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
            // The Modal host sits inside the app's pane provider; the retained output embeds a terminal that reads it.
            const screen = await renderScreen(<AppPaneProvider><ActionOperationDetailModal serverId={serverId} operationId="retained-script"
                onClose={NO_CHANGE} setChrome={setChrome} /></AppPaneProvider>);
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
            credentials: { token: createAccountTokenForTests('account', { currentAccount: true }) },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const inspection = await inspectActionResponse(path, init);
                if (inspection) return inspection;
                const machineReadBearer = new Headers(init?.headers).get('Authorization')?.slice('Bearer '.length);
                const machineRead = machineReadBearer ? createPlainMachineReadHttpResponseFixture(path, init, parseToken(machineReadBearer)) : null;
                if (machineRead) return machineRead;
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
        const changedRead = createDeferred<void>();
        try {
            const workspace: WorkspaceAddressV1 = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), machineId: 'source-machine', workspaceId: 'source-workspace', rootPath: '/source' };
            const answerFor = (command: string) => {
                const manifest = { version: 1 as const, workspace: { setup: [{ kind: 'command' as const, command: 'echo setup' }] },
                    scripts: { build: { source: { kind: 'command' as const, command } } } };
                return ProjectDefinitionInspectOutputSchema.parse({ definition: { basis: { kind: 'present' as const, hash: 'a'.repeat(64) }, document: { status: 'valid' as const,
                    bytes: JSON.stringify(manifest), original: manifest, manifest, diagnostics: [] } },
                    detection: { entries: [], toolchains: [], devcontainers: [], coverage: 'complete' as const, diagnostics: [] }, importCandidates: [],
                    setupReadiness: { kind: 'current', reviewedEffectDigest: 'proven-effect', completedAtMs: 123 } });
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
            inspectionTransport.answer = ProjectDefinitionInspectOutputSchema.parse({ ...answerFor('previous-account-command'),
                setupReadiness: { kind: 'needsReview', code: 'project_setup_effect_changed' } });
            inspectionTransport.hold = changedRead.promise;
            const proven = hook.getCurrent().read;
            await act(async () => { hook.getCurrent().retry(); });
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account']));
            expect(hook.getCurrent().read).toMatchObject({ refreshing: true, value: {
                setupReadiness: { kind: 'current', reviewedEffectDigest: 'proven-effect', completedAtMs: 123 },
            } });
            const refreshing = hook.getCurrent().read;
            expect(refreshing && 'value' in refreshing ? refreshing.value : undefined).toBe(proven && 'value' in proven ? proven.value : undefined);
            await act(async () => { changedRead.resolve(); });
            await vi.waitFor(() => expect(hook.getCurrent().read).toMatchObject({ value: { setupReadiness: {
                kind: 'needsReview', code: 'project_setup_effect_changed',
            } } }));
            inspectionTransport.hold = lateRead.promise;
            await act(async () => { hook.getCurrent().retry(); });
            await vi.waitFor(() => expect(inspectionTransport.accounts).toEqual(['account', 'account', 'account']));
            inspectionTransport.answer = answerFor('replacement-account-command');
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = { token: createAccountTokenForTests('next-account', { currentAccount: true }) };
            await act(async () => { await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, credentials); });
            expect(hook.getCurrent().read).toBeNull();
            await vi.waitFor(() => expect(inspectionTransport.accounts).toContain('next-account'));
            inspectionTransport.hold = null;
            lateRead.resolve();
            await vi.waitFor(() => expect(hook.getCurrent().read).toMatchObject({ value: { definition: { document: { manifest: { scripts: { build: { source: { command: 'replacement-account-command' } } } } } } } }));
            await hook.unmount();
        } finally { changedRead.resolve(); lateRead.resolve(); await connection.dispose(); disposeExecutor(); }
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
            const nextCredentials = { token: createAccountTokenForTests('next-account', { currentAccount: true }) };
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
