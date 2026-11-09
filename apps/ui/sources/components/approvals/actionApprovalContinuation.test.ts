import { describe, expect, it, vi } from 'vitest';
import {
    buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import {
    encodePasswordCredentialFieldV1} from '@happier-dev/protocol/auth/accountPasswordCredential';
import {
    type AcpCatalogSettingsV1} from '@happier-dev/protocol/acp/catalog/settingsV1';
import {
    type ApprovalRequest,
    type ApprovalRequestV2,
} from '@happier-dev/protocol/approvals/approvalRequestV1';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import {
    AgentsAcpBackendsUpsertOutputV1Schema,
} from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { AcpCatalogSettingsV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';

import {
    awaitActionApprovalResult,
    type ActionApprovalResultCallbacks,
    createActionApprovalContinuation,
    createHomeActionApprovalContinuation,
} from './actionApprovalContinuation';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionBoardItemUpsertInputV1Schema, SessionBoardMutationActionResultV1Schema } from '@happier-dev/protocol/sessions/board/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createActionApprovalContinuationObserver } from './actionApprovalContinuation';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { ManagedMachineBirthResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

await initializeRealAppRuntimeForTests();

describe('awaitActionApprovalResult', () => {
    it('rejects a pending read with its typed cancellation when the Account scope retires', async () => {
        const controller = new AbortController();
        const cancellation = Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        const started = createDeferred<void>();
        const rejected = vi.fn();
        const settlement = awaitActionApprovalResult<unknown, object | null>({
            signal: controller.signal,
            execute: async () => { started.resolve(); return { approvalPending: true }; },
            succeeded: () => null,
            failed: code => { throw Object.assign(new Error(code), { code }); },
            aborted: () => { throw cancellation; },
        }).catch(rejected);
        await started.promise;
        controller.abort();
        await Promise.resolve();
        expect(rejected).toHaveBeenCalledWith(cancellation);
        await settlement;
    });

    it.each(['immediate', 'approved'] as const)('settles a legal null managed birth source from %s execution', async mode => {
        const birth = ManagedMachineBirthResultV1Schema.parse({ source: null });
        const executed = createDeferred<ActionApprovalResultCallbacks<typeof birth>>();
        const settlement = awaitActionApprovalResult<typeof birth, typeof birth.source>({
            execute: async callbacks => {
                executed.resolve(callbacks);
                return mode === 'immediate' ? birth.source : { approvalPending: true };
            },
            succeeded: value => value.source,
            failed: code => { throw new Error(code); },
            aborted: () => { throw new Error('unexpected_abort'); },
        });
        const callbacks = await executed.promise;
        if (mode === 'approved') callbacks.onApprovalSucceeded(birth);
        await expect(settlement).resolves.toBeNull();
    });
});

const actionId = 'teams.identity.connections.test.start' as const;
const actionInput = {
    v: 1 as const,
    teamId: 'team-1',
    connectionId: 'connection-1',
    expectedRevision: 2,
};
const actionResult = {
    attemptId: 'attempt-1',
    authorizeUrl: 'https://issuer.example.test/authorize',
};

type ReadableArtifact = Extract<DecryptedArtifact, Readonly<{ isDecrypted: true }>> & Readonly<{ body: string }>;

function executedArtifact(overrides?: Readonly<{
    artifactId?: string;
    actionId?: ApprovalRequestV2['actionId'];
    actionArgs?: unknown;
    accountId?: string;
    serverId?: string;
    surface?: 'ui' | 'api' | 'cli' | 'plugin';
    requestedSurface?: string;
    requestId?: string;
    result?: unknown;
    preview?: unknown;
    executionOrigin?: ApprovalRequestV2['executionOriginV1'];
}>): ReadableArtifact {
    const requestActionId = overrides?.actionId ?? actionId;
    const request: ApprovalRequestV2 = {
        v: 2,
        status: 'executed',
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        requestedSurface: overrides?.requestedSurface ?? 'ui',
        executionOriginV1: overrides?.executionOrigin ?? {
            v: 1,
            authority: 'present_user',
            surface: overrides?.surface ?? 'ui',
            caller: { kind: 'host' },
            serverId: overrides?.serverId ?? 'home-1',
            accountId: overrides?.accountId ?? 'account-1',
            actionId: requestActionId,
            requestId: overrides?.requestId ?? 'request-1',
        },
        actionId: requestActionId,
        actionArgs: overrides?.actionArgs ?? actionInput,
        ...(overrides && 'preview' in overrides ? { preview: overrides.preview } : {}),
        summary: 'Test the Team identity connection',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
            executedAtMs: 2,
            ok: true,
            result: overrides && 'result' in overrides ? overrides.result : actionResult,
        },
    };
    return {
        id: overrides?.artifactId ?? 'approval-1',
        title: null,
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: true,
    };
}

function failedArtifact(overrides?: Readonly<{
    status?: 'failed' | 'outcome_unknown';
    actionId?: ApprovalRequestV2['actionId'];
    actionArgs?: unknown;
    accountId?: string;
    errorCode?: string;
    error?: string;
    details?: unknown;
    executionOrigin?: ApprovalRequestV2['executionOriginV1'];
}>): ReadableArtifact {
    const requestActionId = overrides?.actionId ?? actionId;
    const request: ApprovalRequestV2 = {
        v: 2,
        status: overrides?.status ?? 'failed',
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' },
        requestedSurface: 'ui',
        executionOriginV1: overrides?.executionOrigin ?? {
            v: 1,
            authority: 'present_user',
            surface: 'ui',
            caller: { kind: 'host' },
            serverId: 'home-1',
            accountId: overrides?.accountId ?? 'account-1',
            actionId: requestActionId,
            requestId: 'request-1',
        },
        actionId: requestActionId,
        actionArgs: overrides?.actionArgs ?? actionInput,
        summary: 'Test the Team identity connection',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
            executedAtMs: 2,
            ok: false,
            ...(overrides?.status === 'outcome_unknown' ? { effectAttempted: true } : {}),
            errorCode: overrides?.errorCode ?? 'identity_provider_unavailable',
            error: overrides?.error ?? overrides?.errorCode ?? 'identity_provider_unavailable',
            ...(overrides && 'details' in overrides ? { details: overrides.details } : {}),
        },
    };
    return {
        id: 'approval-1',
        title: null,
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: true,
    };
}

describe('createHomeActionApprovalContinuation', () => {
    it('consumes host-reviewed Board admission while keeping authored operands and caller review facts exact', async () => {
        const boardActionId = 'session.board.item.upsert' as const;
        const input = { sessionId: 'session-1', itemId: 'note-1', expectedItemRevision: null,
            placement: { tabId: 'overview', tabTitle: 'Overview', width: 'medium' },
            item: { v: 1, title: 'Shipping', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Keep this note' } } } },
        } as const;
        let recordedInput: unknown;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            approvalsCreate: async ({ request }) => { recordedInput = request.actionArgs; return { artifactId: 'approval-1' }; },
        }));
        const execution = await executor.execute(boardActionId, input, { surface: 'ui', authority: 'present_user', serverId: 'home-1',
            runtimeAccountId: 'account-1', actionRequestId: 'request-1',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { [boardActionId]: { approvalRequiredSurfaces: ['ui'] } } }),
        });
        expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const admitted = SessionBoardItemUpsertInputV1Schema.parse(recordedInput);
        expect(admitted).toMatchObject(input);
        const result = SessionBoardMutationActionResultV1Schema.parse({ v: 1, serverId: 'home-1', sessionId: 'session-1',
            result: { operation: 'upsert_item', itemId: 'note-1', outcome: 'created',
                itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
            destination: { tabId: 'overview', width: 'medium' },
        });
        const artifact = executedArtifact({ actionId: boardActionId, actionArgs: admitted, result });
        for (const expectedInput of [input, admitted]) {
            const onSucceeded = vi.fn();
            const onFailed = vi.fn();
            await createActionApprovalContinuation({ artifactId: 'approval-1', actionId: boardActionId,
                scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput, onSucceeded, onFailed }).onExecuted(artifact);
            expect(onSucceeded).toHaveBeenCalledWith(result);
            expect(onFailed).not.toHaveBeenCalled();
        }
        for (const expectedInput of [
            { ...input, itemId: 'other-note' },
            { ...input, sessionId: 'other-session' },
            { ...input, item: { ...input.item, title: 'Other note' } },
            { ...input, item: { ...input.item, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Other body' } } } } },
            { ...input, expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
            { ...input, placement: { ...input.placement, width: 'wide' } },
            { ...admitted, copySource: {
                serverId: 'home-1', sessionId: 'source-session', itemId: 'source', expectedItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
            } },
        ]) {
            const onSucceeded = vi.fn();
            const onFailed = vi.fn();
            await createActionApprovalContinuation({ artifactId: 'approval-1', actionId: boardActionId,
                scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput, onSucceeded, onFailed }).onExecuted(artifact);
            expect(onSucceeded).not.toHaveBeenCalled();
            expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
        }
    });
    it('delivers the recorded finite refusal from an Account UI root on a daemon-local Home profile', () => {
        const scriptInput = { workspace: { serverId: 'srv_home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/project' },
            selection: { kind: 'named', name: 'lint' } };
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-token', binding: {
            accountId: 'account-1', custodianAccountId: 'account-1', authentication: { kind: 'account', tokenEpoch: 1 },
            accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: 'machine', installationId: 'installation',
            actionId: 'projects.script.run', requestId: 'request-1', target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'request-1', target, input: scriptInput }),
        } });
        const origin: ApprovalRequestV2['executionOriginV1'] = { v: 1, authority: 'account_automation', surface: 'ui',
            caller: { kind: 'host' }, serverId: 'daemon-local-profile', serverIdentityId: 'srv_home', accountId: 'account-1',
            actionId: 'projects.script.run', requestId: 'request-1', machineId: 'machine', target,
            externalActionExecutionAuthorization: authorization, externalActionInputSignature: signExternalActionApprovalInputV1({
                authorizationToken: authorization.token, actionId: 'projects.script.run', input: scriptInput, target,
                privateKey: new Uint8Array(64),
            }) };
        const artifact = failedArtifact({ actionId: 'projects.script.run', actionArgs: scriptInput, executionOrigin: origin,
            errorCode: 'project_finite_execution_unavailable' });
        expect(approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body)).toMatchObject({ family: 'built_in' });
        const onFailed = vi.fn();
        const create = (serverId = 'srv_home', executionOrigin = origin) => ({
            continuation: createActionApprovalContinuation({ artifactId: 'approval-1', actionId: 'projects.script.run',
                scope: { serverId, accountId: 'account-1' }, expectedInput: scriptInput, onSucceeded: vi.fn(), onFailed }),
            artifact: failedArtifact({ actionId: 'projects.script.run', actionArgs: scriptInput, executionOrigin,
                errorCode: 'project_finite_execution_unavailable' }),
        });
        const matched = create();
        matched.continuation.onTerminal?.('failed', matched.artifact);
        expect(onFailed).toHaveBeenCalledWith('project_finite_execution_unavailable', expect.objectContaining({ ok: false }));
        for (const candidate of [create('srv_other'), create('srv_home', { ...origin,
            externalActionExecutionAuthorization: undefined, externalActionInputSignature: undefined }),
            create('srv_home', { ...origin, externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
                ...authorization, binding: { ...authorization.binding, authentication: { kind: 'terminal', tokenEpoch: 1 } },
            }) })]) {
            onFailed.mockClear();
            candidate.continuation.onTerminal?.('failed', candidate.artifact);
            expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
        }
    });
    it('reports an executed preset refusal without invoking the success continuation', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-1', actionId: 'machines.presets.archive',
            scope: { serverId: 'home-1', accountId: 'account-1' }, onSucceeded, onFailed });
        const result = { kind: 'refused', code: 'provider_unavailable' };
        expect(await continuation.onExecuted(executedArtifact({ actionId: 'machines.presets.archive',
            actionArgs: { homeId: 'home-1', id: 'preset-1', expectedRevision: 0 }, result }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('provider_unavailable', expect.objectContaining({ ok: false, details: result }));
    });

    it('delivers a successful preset read result unchanged', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-1', actionId: 'machines.presets.list',
            scope: { serverId: 'home-1', accountId: 'account-1' }, onSucceeded, onFailed });
        const result = { kind: 'listed', presets: [] };
        expect(await continuation.onExecuted(executedArtifact({ actionId: 'machines.presets.list',
            actionArgs: { homeId: 'home-1' }, result }))).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(result);
        expect(onFailed).not.toHaveBeenCalled();
    });

    it.each(['current', 'account_changed', 'home_changed'] as const)('delivers the real ACP approval receipt and private review only for its current Account/Home (%s)', async admission => {
        const home = await createPlainArtifactHomeFixture('https://acp-continuation.test', {
            accountId: 'account-1', currentAccount: true,
        });
        const [{ captureLazyActionAccountContext }, { isApprovalExecutionOriginCurrentForAccountContext }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'),
            import('@/sync/ops/actions/defaultActionExecutor'),
        ]);
        const account = await captureLazyActionAccountContext(home.home.id);
        try {
            // The mounted ACP editor explicitly sets auth to undefined for an agent without login.
            // The Home's JSON Artifact transport omits that optional native object member.
            const input = { backend: {
                id: 'custom-agent', name: 'custom-agent', title: 'Custom agent', launch: { kind: 'command' as const, command: 'custom-agent', args: [] },
                env: {}, auth: undefined,
            }, expectedRevision: 1 };
            let catalog: AcpCatalogSettingsV1 = { v: 2, backends: [] };
            let storedRequest: ApprovalRequest | null = null;
            let catalogMutations = 0;
            // The Artifact and catalog are persistence ports. Admission, review
            // projection, replay, mutation and receipt production remain real.
            const { StoredApprovalRequestSchema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
            const persist = (request: ApprovalRequest) => {
                storedRequest = StoredApprovalRequestSchema.parse(JSON.parse(JSON.stringify(request)));
            };
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                isApprovalExecutionOriginCurrent: async ({ origin, reportStale }) => {
                    account.assertCurrent();
                    return isApprovalExecutionOriginCurrentForAccountContext({ origin,
                        accountServerId: account.serverId, accountId: account.accountId, reportStale });
                },
                approvalsCreate: async ({ request }) => { persist(request); return { artifactId: 'approval-1' }; },
                approvalsGet: async () => storedRequest,
                approvalsUpdate: async ({ request }) => { persist(request); return { ok: true }; },
                updateAccountAcpCatalogSettings: async ({ mutate, expectedRevision }) => {
                    catalogMutations += 1;
                    expect(expectedRevision).toBe(1);
                    catalog = AcpCatalogSettingsV1Schema.parse(mutate(catalog));
                    return { ok: true, revision: 2 };
                },
            }));
            const context = { surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const }, serverId: account.serverId, runtimeAccountId: account.accountId,
                actionRequestId: 'request-1', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { 'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] } },
                }),
            };
            expect(computeActionInputApprovalDigestV1('agents.acp.backends.upsert', input)).toBe(
                computeActionInputApprovalDigestV1('agents.acp.backends.upsert', JSON.parse(JSON.stringify(input))),
            );
            const created = await executor.execute('agents.acp.backends.upsert', input, context);
            expect(created.ok, created.ok ? undefined : created.errorCode).toBe(true);
            expect(created).toMatchObject({
                ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1' },
            });
            expect(catalog.backends).toEqual([]);
            if (admission !== 'current') {
                const request = StoredApprovalRequestSchema.parse(storedRequest);
                if (request.v !== 2) throw new Error('Expected a current approval origin');
                persist({ ...request, executionOriginV1: { ...request.executionOriginV1,
                    ...(admission === 'account_changed' ? { accountId: 'another-account' } : { serverId: 'another-home' }),
                } });
            }
            await expect(executor.execute('approval.request.decide', { artifactId: 'approval-1', decision: 'approve' }, context))
                .resolves.toMatchObject({ ok: true });
            const request = StoredApprovalRequestSchema.parse(storedRequest);
            const artifact: ReadableArtifact = { id: 'approval-1', title: null,
                header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2, isDecrypted: true,
            };
            const terminal = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
            if (admission !== 'current') {
                expect(terminal).toMatchObject({ family: 'built_in', request: { status: 'failed', execution: {
                    ok: false, errorCode: 'approval_stale', effectAttempted: false, details: { reason: admission },
                } } });
                expect(catalogMutations).toBe(0);
                expect(catalog.backends).toEqual([]);
                return;
            }
            expect(terminal).toMatchObject({ family: 'built_in', request: { status: 'executed', execution: { ok: true } } });
            if (terminal?.family !== 'built_in') throw new Error('Invalid stored approval fixture');
            const result = AgentsAcpBackendsUpsertOutputV1Schema.parse(terminal.request.execution?.result);
            expect(result).toMatchObject({ backend: { id: input.backend.id }, revision: 2 });
            expect(catalog.backends).toEqual([result.backend]);
            expect(terminal.request.actionArgs).toEqual({ backend: {
                id: 'custom-agent', name: 'custom-agent', title: 'Custom agent', launch: { kind: 'command' as const, command: 'custom-agent', args: [] }, env: [],
            }, expectedRevision: 1 });
            expect(terminal.request.preview).toMatchObject({ actionId: 'agents.acp.backends.upsert', actionArgs: {
                backend: { env: [] }, expectedRevision: 1,
            } });

            const onSucceeded = vi.fn();
            const onFailed = vi.fn();
            const continuation = createActionApprovalContinuation({
                artifactId: artifact.id, actionId: 'agents.acp.backends.upsert',
                scope: { serverId: account.serverId, accountId: account.accountId }, expectedInput: input, onSucceeded, onFailed,
            });
            expect(await continuation.onExecuted(artifact)).toBe('consumed');
            expect(onFailed).not.toHaveBeenCalled();
            expect(onSucceeded).toHaveBeenCalledWith(result);
            for (const expectedInput of [{ ...input, expectedRevision: 2 },
                { ...input, backend: { ...input.backend, name: 'other-agent' } },
                { ...input, backend: { ...input.backend, launch: { ...input.backend.launch, command: 'other-agent' } } }]) {
                onSucceeded.mockClear();
                onFailed.mockClear();
                await createActionApprovalContinuation({ artifactId: artifact.id, actionId: 'agents.acp.backends.upsert',
                    scope: { serverId: account.serverId, accountId: account.accountId }, expectedInput, onSucceeded, onFailed }).onExecuted(artifact);
                expect(onSucceeded).not.toHaveBeenCalled();
                expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
            }
            for (const backend of [
                { ...input.backend, env: [], name: 'other-agent' },
                { ...input.backend, env: {}, unexpected: 'unvalidated-review' },
            ]) {
                onSucceeded.mockClear();
                onFailed.mockClear();
                const alteredArtifact = { ...artifact, body: JSON.stringify({ ...request,
                    preview: { actionId: 'agents.acp.backends.upsert', actionArgs: { backend, expectedRevision: 1 } },
                }) };
                expect(approvalArtifactBodyMatchesHeaderV1(alteredArtifact.header ?? {}, alteredArtifact.body))
                    .toMatchObject({ family: 'built_in' });
                await continuation.onExecuted(alteredArtifact);
                expect(onSucceeded).not.toHaveBeenCalled();
                expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
            }
        } finally {
            account.dispose();
            await home.dispose();
        }
    });
    it('delivers an exact immutable Agent terminal receipt and rejects altered origin facts', async () => {
        const terminalActionId = 'machines.terminal.restart' as const;
        const input = { serverId: 'home-1', machineId: 'machine-1', terminalKey: 'requester-owned', cwd: '/accepted',
            workspace: { serverId: 'home-1', workspaceId: 'accepted', machineId: 'machine-1', rootPath: '/accepted' } };
        const origin: ApprovalRequestV2['executionOriginV1'] = { v: 1, authority: 'account_automation', surface: 'agent',
            caller: { kind: 'host' }, serverId: 'home-1', accountId: 'account-1', actionId: terminalActionId, requestId: 'agent-restart' };
        const receipt = { ok: true, terminalId: 'requester-pty', reused: false };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const create = () => createActionApprovalContinuation({ artifactId: 'approval-1', actionId: terminalActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput: input, expectedRequestId: origin.requestId,
            expectedExecutionOrigin: origin, onSucceeded, onFailed });
        const artifact = (executionOrigin: typeof origin) => executedArtifact({ actionId: terminalActionId, actionArgs: input,
            executionOrigin, requestedSurface: executionOrigin.surface, result: receipt });
        // This is the strict stored daemon receipt boundary, not an executor or
        // authority mock. The canonical Artifact header/body matcher is real.
        expect(await create().onExecuted(artifact(origin))).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(receipt);
        expect(onFailed).not.toHaveBeenCalled();
        for (const changed of [{ ...origin, surface: 'voice' as const }, { ...origin, authority: 'present_user' as const },
            { ...origin, caller: { kind: 'session' as const, sessionId: 'other-agent', starterDepth: 0, turnDepth: 0 } }]) {
            onSucceeded.mockClear(); onFailed.mockClear();
            expect(await create().onExecuted(artifact(changed))).toBe('consumed');
            expect(onSucceeded).not.toHaveBeenCalled();
            expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
        }
    });
    it('delivers the exact executed result through the canonical Action output schema', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact())).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(actionResult);
        expect(onFailed).not.toHaveBeenCalled();
    });

    it('ignores an Artifact with another identity without consuming the exact pending operation', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({ artifactId: 'approval-other' }))).toBe('ignored');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).not.toHaveBeenCalled();
    });

    it.each([
        ['wrong Action', executedArtifact({ actionId: 'teams.identity.connections.disable' })],
        ['wrong Account', executedArtifact({ accountId: 'account-other' })],
        ['wrong Home', executedArtifact({ serverId: 'home-other' })],
    ])('fails a same-Artifact %s binding instead of silently losing the result', async (_label, artifact) => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it('rejects the same Action when the approval belongs to different canonical input', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: actionInput,
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionArgs: { ...actionInput, connectionId: 'connection-other' },
        }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it('rejects the same Action when the approval belongs to another request identity', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedRequestId: 'request-1',
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({ requestId: 'request-other' }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it.each([
        ['non-UI origin', executedArtifact({ surface: 'api' })],
        ['non-UI requested surface', executedArtifact({ requestedSurface: 'api' })],
    ])('rejects a structurally contradictory %s artifact as invalid', async (_label, artifact) => {
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded: vi.fn(),
            onFailed,
        });

        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(onFailed).toHaveBeenCalledWith('approval_invalid');
    });

    it('fails a malformed exact Artifact as invalid', async () => {
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded: vi.fn(),
            onFailed,
        });
        const artifact = executedArtifact();

        expect(await continuation.onExecuted({ ...artifact, body: '{' })).toBe('consumed');
        expect(onFailed).toHaveBeenCalledWith('approval_invalid');
    });

    it('reports an invalid recorded result without manufacturing success', async () => {
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({ result: { v: 1 } }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('invalid_action_output');
    });

    it('releases an unknown approval outcome through the mounted continuation without rerunning the Action', () => {
        const onFailed = vi.fn();
        const onSucceeded = vi.fn();
        const continuation = createHomeActionApprovalContinuation({ artifactId: 'approval-1', actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, onSucceeded, onFailed });
        const observer = createActionApprovalContinuationObserver({ onExecuted: vi.fn() });
        observer.requestApproval(continuation);
        observer.observeArtifact(failedArtifact({ status: 'outcome_unknown', errorCode: 'approval_execution_outcome_unknown' }));
        observer.deliverSettlement();
        expect(observer.getSnapshot().approval).toBeNull();
        expect(onFailed).toHaveBeenCalledWith('approval_execution_outcome_unknown', {
            ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown',
        });
        expect(onSucceeded).not.toHaveBeenCalled();
        observer.dispose();
    });

    it('preserves the exact failed execution code after validating the same Action binding', () => {
        const onFailed = vi.fn();
        const continuation = createHomeActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            onSucceeded: vi.fn(),
            onFailed,
        });

        continuation.onTerminal?.('failed', failedArtifact());
        expect(onFailed).toHaveBeenCalledWith('identity_provider_unavailable', {
            ok: false,
            errorCode: 'identity_provider_unavailable',
            error: 'identity_provider_unavailable',
        });

        onFailed.mockClear();
        continuation.onTerminal?.('failed', failedArtifact({ actionId: 'teams.identity.connections.disable' }));
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });
});

describe('createActionApprovalContinuation', () => {
    it('binds the producer private Profile review even without a separate review schema', async () => {
        const actionId = 'launch_profiles.save';
        const input = { id: 'profile-a', expectedRevision: 4, profile: {
            v: 2, id: 'profile-a', name: 'Reviewed draft', createdAt: 1, updatedAt: 2,
        } };
        let recorded: ApprovalRequest | undefined;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            approvalsCreate: async ({ request }) => { recorded = request; return { artifactId: 'approval-1' }; },
        }));
        expect(await executor.execute(actionId, input, {
            surface: 'ui', authority: 'present_user', serverId: 'home-1', runtimeAccountId: 'account-1',
            actionRequestId: 'request-1', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
        })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!recorded) throw new Error('Expected the real executor to produce an approval');
        const result = { status: 'updated', id: input.id, revision: 5 };
        const artifact = executedArtifact({ actionId, actionArgs: recorded.actionArgs, preview: recorded.preview, result });
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        await createActionApprovalContinuation({ artifactId: 'approval-1', actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput: input, onSucceeded, onFailed }).onExecuted(artifact);
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith(result);
        for (const expectedInput of [
            { ...input, expectedRevision: 3 },
            { ...input, profile: { ...input.profile, name: 'Unreviewed draft' } },
        ]) {
            onSucceeded.mockClear(); onFailed.mockClear();
            await createActionApprovalContinuation({ artifactId: 'approval-1', actionId,
                scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput, onSucceeded, onFailed }).onExecuted(artifact);
            expect(onSucceeded).not.toHaveBeenCalled();
            expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
        }
    });
    it.each(['legacy', 'dimensions'] as const)('reads a strict %s options approval through the same controller response reader', async format => {
        const actionId = 'machines.provisioners.options';
        const actionArgs = { homeId: 'home-1', controller: { machineId: 'host', installationId: 'installation' },
            contribution: { pluginId: 'custom.compute', localId: 'vm' }, selectors: {} };
        const dimensions = { size: [{ id: 'native', title: 'Native guest', assignments: [] }], image: [], location: [], network: [], duration: [] };
        const result = format === 'legacy' ? { choices: [{ id: 'native', title: 'Native guest', launch: { cpu: 2 } }] }
            : { base: { launch: { cpu: 2 } }, dimensions };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-1', actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput: actionArgs, onSucceeded, onFailed });
        expect(await continuation.onExecuted(executedArtifact({ actionId, actionArgs, result }))).toBe('consumed');
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith({ base: { launch: { cpu: 2 } }, dimensions });
    });
    it('refuses malformed legacy options in deferred approval instead of weakening output admission', async () => {
        const actionId = 'machines.provisioners.options';
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-1', actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, onSucceeded, onFailed });
        await continuation.onExecuted(executedArtifact({ actionId, result: { choices: [{ id: 'native', title: 'Guest', launch: { cpu: 2 }, unexpected: true }] } }));
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('invalid_action_output', { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
    });
    it('does not report success for an executed worker policy conflict', async () => {
        const actionId = 'machines.worker.policy.set';
        const actionArgs = { serverId: 'home-1', machineId: 'worker', expectedMetadataVersion: 3,
            expectedPolicy: { accepting: true, runAtMost: null }, policy: { accepting: false, runAtMost: null } };
        const result = { status: 'conflict', policy: { accepting: true, runAtMost: 2 }, metadataVersion: 4 };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({ artifactId: 'approval-1', actionId,
            scope: { serverId: 'home-1', accountId: 'account-1' }, expectedInput: actionArgs,
            onSucceeded, onFailed });
        expect(await continuation.onExecuted(executedArtifact({ actionId, actionArgs, result }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('conflict', { ok: false, errorCode: 'conflict', error: 'conflict', details: result });
    });
    it('delivers strict deferred Board failure details through the canonical failure envelope', () => {
        const boardActionId = 'session.board.layout.update' as const;
        const boardInput = {
            sessionId: 'session-1',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: boardActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: boardInput,
            onSucceeded: vi.fn(),
            onFailed,
        });

        continuation.onTerminal?.('failed', failedArtifact({
            actionId: boardActionId,
            actionArgs: boardInput,
            errorCode: 'session_board_revision_conflict',
            details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
        }));

        expect(onFailed).toHaveBeenCalledWith(
            'session_board_revision_conflict',
            {
                ok: false,
                errorCode: 'session_board_revision_conflict',
                error: 'session_board_revision_conflict',
                details: { currentLayoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
            },
        );
    });

    it('settles a live-only-custody Action whose durable record carries only the observation projection', async () => {
        // `account.password.enroll` declares `approvalInputCustody: 'live_only'`,
        // so the executor records the Action's own observation projection — not
        // the credential, verification bearer or reauthentication proof the
        // caller holds. The continuation must still recognise its own approval.
        const enrollActionId = 'account.password.enroll' as const;
        const enrollInput = {
            v: 1 as const,
            kind: 'plain' as const,
            email: 'person@example.test',
            targetCredential: {
                v: 1 as const,
                kind: 'plain_password_hash' as const,
                hash: {
                    v: 1 as const,
                    algorithm: 'scrypt' as const,
                    parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
                    salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                    digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
                },
            },
            verificationToken: 'A'.repeat(43),
            reauthentication: { provider: 'github', pending: 'pending-1', proof: 'proof-1' },
        };
        const observedEnrollInput = { v: 1, kind: 'plain' } as const;
        const enrollResult = { v: 1 as const, status: 'enrolled' as const };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: enrollActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: enrollInput,
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionId: enrollActionId,
            actionArgs: observedEnrollInput,
            preview: { actionId: enrollActionId, actionArgs: observedEnrollInput },
            result: enrollResult,
        }))).toBe('consumed');
        expect(onFailed).not.toHaveBeenCalled();
        expect(onSucceeded).toHaveBeenCalledWith(enrollResult);
    });

    it('still refuses a projecting Action whose observed input names another resource', async () => {
        // Everything the projection keeps — owner, id, revision — still binds.
        // Only the redacted secret itself stops distinguishing two approvals.
        const replaceActionId = 'identity.providers.secret.replace' as const;
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: replaceActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: {
                owner: { kind: 'home' },
                id: 'provider-1',
                expectedRevision: 3,
                clientSecret: 'client-secret-value',
            },
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionId: replaceActionId,
            actionArgs: { owner: { kind: 'home' }, id: 'provider-other', expectedRevision: 3 },
            preview: {
                actionId: replaceActionId,
                actionArgs: { owner: { kind: 'home' }, id: 'provider-other', expectedRevision: 3 },
            },
            result: { outcome: 'removed' },
        }))).toBe('consumed');
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch');
    });

    it('settles an exact non-Home-domain Action through its canonical Action output schema', async () => {
        const boardActionId = 'session.board.layout.update' as const;
        const boardInput = {
            sessionId: 'session-1',
            expectedLayoutRevision: null,
            operation: { op: 'tab.create' as const, tabId: 'overview', title: 'Overview' },
        };
        const boardResult = {
            v: 1 as const,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: {
                operation: 'update_layout' as const,
                outcome: 'created' as const,
                layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
            },
            destination: null,
        };
        const onSucceeded = vi.fn();
        const onFailed = vi.fn();
        const continuation = createActionApprovalContinuation({
            artifactId: 'approval-1',
            actionId: boardActionId,
            scope: { serverId: 'home-1', accountId: 'account-1' },
            expectedInput: boardInput,
            onSucceeded,
            onFailed,
        });

        expect(await continuation.onExecuted(executedArtifact({
            actionId: boardActionId,
            actionArgs: boardInput,
            result: boardResult,
        }))).toBe('consumed');
        expect(onSucceeded).toHaveBeenCalledWith(boardResult);
        expect(onFailed).not.toHaveBeenCalled();
    });
});
