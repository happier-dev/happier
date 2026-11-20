import { randomBytes, randomUUID } from 'node:crypto';
import axios, { AxiosHeaders, type AxiosAdapter } from 'axios';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { WorkflowProgressEnvelopeV1Schema, WorkflowRunInvocationIndexV1Schema, WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ReviewCommentPrincipalHeaderV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentCreateResponseV1Schema, ReviewCommentPrincipalHeaderV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { prepareWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import type { AvailableAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../../cli/src/agent/reviews/comments/executor';
import { createReviewRunCommentService } from '../../../../../cli/src/agent/executionRuns/profiles/review/reviewComments';
import { materializeWorkflowSessionReview } from '../../../../../cli/src/daemon/workflows/reviewSessionStep';
import type { ExecutionRunState } from '../../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { createReviewCommentPrincipalSigningInputV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { auth } from '@/app/auth/auth';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createTrustedMachineInstallation } from '@/testkit/pluginInstallationPublisherTestkit';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { registerReviewCommentRoutes } from './routes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

function unused(): Promise<never> {
    return Promise.reject(new Error('unexpected_action_dependency'));
}

function actionDependencies(overrides: Partial<ActionExecutorDeps>): ActionExecutorDeps {
    return {
        executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
        detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused, executionRunWait: unused,
        sessionOpen: unused, sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused,
        pathsListRecent: unused, projectsList: unused, machinesList: unused, serversList: unused,
        reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
        agentsConfigOptionsList: unused, agentsSessionModesList: unused, spawnProfilesList: unused,
        spawnConnectedServicesList: unused, spawnMcpServersPreview: unused,
        sessionSendMessage: unused, sessionPermissionRespond: unused, sessionUserActionAnswer: unused,
        sessionModeSet: unused, sessionModesList: unused, sessionTargetPrimarySet: unused,
        sessionTargetTrackedSet: unused, sessionList: unused, sessionActivityGet: unused,
        sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: () => { throw new Error('unexpected_voice_dependency'); },
        teleportVoiceAgentToSessionRoot: unused,
        daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        ...overrides,
    };
}

describe('credentialed Workflow ReviewComment authority at Home', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-workflow-review-scope-', initAuth: true, initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['detached', 'session', 'workflow_session'] as const)('persists native findings through the signed host and durable Home owner: %s', async origin => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const machineId = randomUUID(), installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        const otherMachineId = randomUUID(), otherInstallationId = randomUUID();
        await createTrustedMachineInstallation({ accountId: account.id, machineId: otherMachineId,
            installationId: otherInstallationId, keyPair });
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: account.id,
            header: Buffer.from(encodePlainArtifactStoredContent({ title: 'Native review' }), 'base64'),
            body: Buffer.from(encodePlainArtifactStoredContent({ body: '' }), 'base64'),
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'), reviewMetadata: { create: {
                subjectKind: 'repository', sourceKind: 'direct', state: 'running', currentRoundOrdinal: 1, startedAt: new Date(1),
            } } } });
        const sessionId = origin === 'detached' ? null : randomUUID();
        if (sessionId) await db.session.create({ data: { id: sessionId, accountId: account.id,
            tag: sessionId, metadata: '{}', encryptionMode: 'plain' } });
        const run: ExecutionRunState = { runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID(), sessionId,
            depth: 0, intent: 'review', backendId: 'coderabbit', backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
            instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
            ioMode: 'request_response', status: 'running', startedAtMs: 1,
            intentInput: { reviewReviewerId: 'native-reviewer' } };
        await withAuthenticatedTestApp(app => { registerReviewCommentRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app); }, async app => {
            let attack: 'none' | 'machine' | 'account' | 'run' | 'engine' = 'none';
            const requests: Array<{ path: string; status: number; body: unknown }> = [];
            const previousAdapter = axios.defaults.adapter;
            const adapter: AxiosAdapter = async config => {
                const headers = AxiosHeaders.from(config.headers);
                const path = new URL(config.url!, 'http://localhost').pathname;
                if (attack === 'account' && path.startsWith('/v1/reviews/comments')) headers.set('Authorization', `Bearer ${outsiderToken}`);
                if ((attack === 'run' || attack === 'engine') && path.startsWith('/v1/reviews/comments')) {
                    const principal = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(
                        String(headers.get(REVIEW_COMMENT_PRINCIPAL_HEADER_V1)), 'base64url').toString('utf8')));
                    if (principal.actor.kind !== 'executionRun' || !principal.proof) throw new Error('detached_run_principal_missing');
                    if (attack === 'run') principal.actor.runId = 'another-run';
                    else {
                        if (!principal.currentIntent) throw new Error('run_current_intent_missing');
                        principal.actor.agentId = 'another-engine';
                        principal.currentIntent.agentId = 'another-engine';
                    }
                    const { signatureBase64Url: _signature, ...unsignedProof } = principal.proof;
                    principal.proof.signatureBase64Url = Buffer.from(tweetnacl.sign.detached(
                        createReviewCommentPrincipalSigningInputV1({ ...principal, proof: unsignedProof }),
                        keyPair.secretKey)).toString('base64url');
                    headers.set(REVIEW_COMMENT_PRINCIPAL_HEADER_V1, Buffer.from(JSON.stringify(principal)).toString('base64url'));
                }
                const response = await app.inject({ method: config.method?.toUpperCase() as 'GET' | 'POST' | 'PATCH',
                    url: new URL(config.url!, 'http://localhost').pathname, headers: headers.toJSON() as Record<string, string>,
                    ...(config.params ? { query: config.params } : {}),
                    ...(config.data ? { payload: typeof config.data === 'string' ? JSON.parse(config.data) : config.data } : {}) });
                requests.push({ path: new URL(config.url!, 'http://localhost').pathname, status: response.statusCode, body: response.json() });
                return { data: response.json(), status: response.statusCode, statusText: response.statusMessage,
                    headers: response.headers, config };
            };
            axios.defaults.adapter = adapter;
            try {
                const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                    resolveAccountId: () => account.id, resolveAccountEncryptionMode: async () => 'plain',
                    resolvePrincipalSigningContext: async () => ({ machineId: attack === 'machine' ? otherMachineId : machineId,
                        installationId: attack === 'machine' ? otherInstallationId : installationId,
                        privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
                const service = createReviewRunCommentService({ cwd: '/repo', scope: { workspace: { machineId, path: '/repo' } }, execute });
                if (origin === 'workflow_session' && sessionId) {
                    // Captured mixed-review topology: the fresh model Session is
                    // distinct from the Workflow's original source Session.
                    const originSessionId = randomUUID(), logicalInvocationId = randomUUID(), invocationId = randomUUID();
                    await db.session.create({ data: { id: originSessionId, accountId: account.id,
                        tag: originSessionId, metadata: '{}', encryptionMode: 'plain' } });
                    const step = { kind: 'step' as const, id: 'review',
                        document: { text: 'Review', references: [], attachments: [] }, input: [],
                        execution: { conversation: { kind: 'fresh' as const } } };
                    const definition = validateWorkflowDefinition({ version: 1,
                        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
                        blocks: [step] }).normalizedDefinition;
                    if (!definition) throw new Error('invalid_session_review_workflow');
                    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
                        context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
                            workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                            origin: { kind: 'direct', originSessionId }, authorization: { principal: { kind: 'host' } } },
                        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
                    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
                    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                        binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId: run.runId }, acceptedSnapshot: accepted.snapshot }));
                    await db.automationRun.create({ data: { id: run.runId, accountId: account.id,
                        originKind: 'direct', causeKind: null, originSessionId, scheduledAt: new Date(), dueAt: new Date(),
                        workflowAcceptedSnapshotEnvelope: acceptedEnvelope,
                        workflowCustodyState: 'pending', claimedByMachineId: machineId, assignments: { create: { machineId } } } });
                    const baseProgress = { kind: 'happier.workflow-progress.v1' as const,
                        invocationPath: { blockId: 'review', scope: [] }, blockKind: 'step' as const,
                        attempt: '1', logicalInvocationRecordId: logicalInvocationId,
                        execution: { kind: 'session' as const, sessionId, localInputId: 'actual-model-input' } };
                    const progress = WorkflowProgressEnvelopeV1Schema.parse({ ...baseProgress, previousAttemptRecordId: logicalInvocationId });
                    for (const row of [{ id: logicalInvocationId, sequence: 1n, attempt: 0n, lifecycle: 'superseded' },
                        { id: invocationId, sequence: 2n, attempt: 1n, lifecycle: 'running' }] as const) {
                        await db.workflowRunInvocation.create({ data: { id: row.id, runId: run.runId,
                            sequence: row.sequence, parentRecordId: null, memberOrdinal: 0n, attempt: row.attempt,
                            contentRevision: 1n, lifecycle: row.lifecycle,
                            contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                                progress: WorkflowProgressEnvelopeV1Schema.parse({ ...baseProgress, attempt: row.attempt.toString(),
                                    ...(row.attempt === 0n ? {} : { previousAttemptRecordId: logicalInvocationId }) }),
                                binding: { v: 1, purpose: 'invocation_progress', accountId: account.id, runId: run.runId,
                                    recordId: row.id, sequence: row.sequence.toString(), parentRecordId: null, memberOrdinal: '0',
                                    attempt: row.attempt.toString() } })) } });
                    }
                    const materializeSession = (id: string, physicalInvocationId = invocationId) => materializeWorkflowSessionReview({
                        context: { surface: 'agent', serverId: 'home' },
                        workspace: { machineId, path: '/repo' }, agentId: 'coderabbit', serverId: 'home',
                        sessionId, localInputId: 'actual-model-input',
                        rawText: JSON.stringify({ reviewOutcome: 'complete', summary: 'Inspected.', overviewMarkdown: 'Inspected.',
                            findings: [{ id, title: 'Rollback omitted', severity: 'high', category: 'correctness',
                                summary: 'Restore the previous state when publication fails.' }], questions: [], assumptions: [] }),
                        comments: request => execute(request.actionId, request.input,
                            request.reviewCommentPrincipal ? { principal: request.reviewCommentPrincipal } : undefined),
                        params: { runId: run.runId, invocationRecordId: physicalInvocationId, invocation: progress,
                            step,
                            input: { text: 'Review', references: [], attachments: [], values: [
                                { reviewRound: { reviewId, roundOrdinal: 1 } }, { kind: 'review_session.v1', reviewerId: 'model-reviewer' }] },
                            execution: {}, executionTarget: { kind: 'session' }, originSessionId,
                            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'read-only' },
                            workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' },
                            beforeInputAdmission: unused, onInputAccepted: unused },
                    });
                    const result = await materializeSession('workflow-model-finding');
                    expect(result, JSON.stringify(requests)).toMatchObject({ kind: 'completed', result: {
                        perEngineOutcome: [{ key: 'model-reviewer', outcome: 'completed', materialization: { kind: 'complete' } }],
                        commentIds: [expect.any(String)],
                    } });
                    const stored = await db.reviewComment.findFirstOrThrow({ where: { reviewId } });
                    expect(stored).toMatchObject({ runId: run.runId, sessionId, serverRevision: 1 });
                    expect(JSON.parse(stored.authorJson)).toEqual({ kind: 'workflow', runId: run.runId });
                    for (const kind of ['machine', 'account'] as const) {
                        attack = kind;
                        expect(await materializeSession(`foreign-${kind}`)).toMatchObject({ kind: 'completed', result: {
                            commentIds: [], perEngineOutcome: [{ materialization: { kind: 'failed', errorCode: 'review_comment_permission_denied' } }],
                        } });
                    }
                    attack = 'none';
                    expect(await materializeSession('foreign-invocation', randomUUID())).toMatchObject({ kind: 'completed', result: {
                        commentIds: [], perEngineOutcome: [{ materialization: { kind: 'failed', errorCode: 'review_comment_permission_denied' } }],
                    } });
                    expect(await db.reviewComment.count({ where: { reviewId } })).toBe(1);
                    return;
                }
                const materialize = (id: string) => service.materialize({ run, review: { reviewId, roundOrdinal: 1 },
                    reviewedFingerprint: null, findings: [{ id, title: 'Rollback omitted', severity: 'high', category: 'correctness', summary: 'Restore the previous state when publication fails.' }] });
                const result = await materialize('native-finding');
                expect(result, JSON.stringify(requests)).toMatchObject({ status: 'materialized', failures: [] });
                expect(result.commentIds).toHaveLength(1);
                const stored = await db.reviewComment.findUniqueOrThrow({ where: { id: result.commentIds[0] } });
                expect(stored).toMatchObject({ reviewId, runId: run.runId, sessionId, serverRevision: 1 });
                expect(JSON.parse(stored.authorJson)).toEqual(sessionId
                    ? { kind: 'agent', agentId: 'coderabbit', sessionId }
                    : { kind: 'executionRun', agentId: 'coderabbit', runId: run.runId });
                expect(await execute('reviews.comments.list', { reviewId, authorKind: sessionId ? 'agent' : 'executionRun',
                    authorId: 'coderabbit', includeHistory: true })).toMatchObject({ items: [{ id: stored.id }] });
                const read = ReviewCommentCreateResponseV1Schema.parse(await execute('reviews.comments.create', {
                    reviewId, workspace: { machineId, path: '/repo' }, anchor: { kind: 'file', filePath: 'control.ts' },
                    snapshot: { kind: 'none', capturedAt: 1 }, body: 'Person control', clientMutationId: randomUUID(),
                }));
                expect(read.comment.author).toEqual({ kind: 'user', userId: account.id });
                if (origin === 'detached') {
                    for (const kind of ['machine', 'account', 'run', 'engine'] as const) {
                        attack = kind;
                        expect(await materialize(`forged-${kind}`)).toMatchObject({ status: 'failed', commentIds: [],
                            failures: [{ errorCode: 'review_comment_permission_denied' }] });
                    }
                    expect(await db.reviewComment.count({ where: { reviewId } })).toBe(2);
                }
            } finally { axios.defaults.adapter = previousAdapter; }
        }, { authentication: 'real' });
    });

    it.each(['origin', 'originless', 'nested', 'nested_e2ee'] as const)('reads the admitted reviewSession through the real signed Action transport: %s', async origin => {
        const mode = origin === 'nested_e2ee' ? 'e2ee' : 'plain';
        const nested = origin === 'nested' || origin === 'nested_e2ee';
        const accountKeys = tweetnacl.box.keyPair();
        const account = await db.account.create({ data: { ...(mode === 'e2ee'
            ? createSignedAccountContentBinding(accountKeys.publicKey) : { publicKey: randomUUID() }), encryptionMode: mode } });
        const targetOwner = await db.account.create({ data: { ...(mode === 'e2ee'
            ? createSignedAccountContentBinding() : { publicKey: randomUUID() }), encryptionMode: mode } });
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'dataKey', machineKey: accountKeys.secretKey }, dataKeyPublicKey: accountKeys.publicKey });
        const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
            ? { kind: 'available', witness: { mode: 'plain', version: account.seq, contentKeyFingerprint: null } }
            : { kind: 'available', witness: { mode: 'e2ee', version: account.seq,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
        const runKeys = prepareWorkflowRunDataKeyV1({ accountId: account.id, encryption, randomBytes });
        const runSealMode = runKeys.runCrypto.mode === 'plain' ? { mode: 'plain' as const }
            : { mode: 'e2ee' as const, runDataKey: runKeys.runCrypto.runDataKey, randomBytes };
        const machineId = randomUUID();
        const installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        const otherMachineId = randomUUID();
        const otherInstallationId = randomUUID();
        await createTrustedMachineInstallation({ accountId: account.id, machineId: otherMachineId, installationId: otherInstallationId, keyPair });
        const originId = randomUUID();
        const targetId = randomUUID();
        const siblingId = randomUUID();
        const unrelatedId = randomUUID();
        for (const id of [originId, targetId, siblingId, unrelatedId]) {
            await db.session.create({ data: { id, accountId: id === targetId || id === siblingId ? targetOwner.id : account.id,
                tag: id, metadata: '{}', encryptionMode: mode } });
        }
        await db.sessionGrant.createMany({ data: ([targetId, siblingId].map(sessionId => ({
            sessionId, createdByAccountId: targetOwner.id, accountId: account.id, accessLevel: 'edit',
        }))).map(data => ({ ...data, principalKind: 'account' })) });
        // A real person explicitly chooses the target. A Session-origin field
        // does not turn this user admission into an autonomous Session grant.
        const address = { serverId: 'home', sessionId: targetId };
        const siblingAddress = { serverId: 'home', sessionId: siblingId };
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            const requests: Array<{ path: string; status: number; error?: string }> = [];
            let revokeBeforeCommit = false;
            let tamperSignedScope = false;
            const previousAdapter = axios.defaults.adapter;
            // HTTP is the system boundary; crypto, strict transport, principal
            // admission, Account access and durable SQLite storage remain real.
            const adapter: AxiosAdapter = async config => {
                const url = new URL(config.url!, 'http://localhost');
                if (revokeBeforeCommit && url.pathname === '/v1/reviews/comments/mutations/commit') {
                    revokeBeforeCommit = false;
                    await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: targetId, accountId: account.id } });
                }
                const headers = AxiosHeaders.from(config.headers);
                if (tamperSignedScope) {
                    const encoded = headers.get(REVIEW_COMMENT_PRINCIPAL_HEADER_V1);
                    if (typeof encoded !== 'string') throw new Error('signed_principal_missing');
                    const principal = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
                    if (!principal.workflowScope) throw new Error('signed_workflow_scope_missing');
                    principal.workflowScope.sessions = [{ serverId: 'home', sessionId: unrelatedId }];
                    headers.set(REVIEW_COMMENT_PRINCIPAL_HEADER_V1, Buffer.from(JSON.stringify(principal)).toString('base64url'));
                }
                const response = await app.inject({ method: config.method?.toUpperCase() as 'GET' | 'POST' | 'PATCH',
                    url: url.pathname, headers: headers.toJSON() as Record<string, string>,
                    ...(config.params ? { query: config.params } : {}),
                    ...(config.data ? { payload: typeof config.data === 'string' ? JSON.parse(config.data) : config.data } : {}) });
                const payload: unknown = response.json();
                const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : undefined;
                requests.push({ path: url.pathname, status: response.statusCode, ...(error ? { error } : {}) });
                return { data: payload, status: response.statusCode, statusText: response.statusMessage, headers: response.headers, config };
            };
            axios.defaults.adapter = adapter;
            try {
                let signerMachineId = machineId;
                const transport = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token,
                    encryption: mode === 'plain' ? null : { type: 'dataKey', publicKey: accountKeys.publicKey, machineKey: accountKeys.secretKey } },
                    resolveAccountId: () => account.id, resolveAccountEncryptionMode: async () => mode,
                    resolvePrincipalSigningContext: async () => ({ machineId: signerMachineId,
                        installationId: signerMachineId === machineId ? installationId : otherInstallationId,
                        privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
                const workspace = { machineId, path: '/repo' };
                const comments = new Map<string, string>();
                for (const sessionId of nested ? [targetId, siblingId] : [targetId]) {
                    const created = ReviewCommentCreateResponseV1Schema.parse(await transport('reviews.comments.create', {
                        workspace, sessionId, anchor: { kind: 'file', filePath: 'example.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                        body: 'Admitted target finding', authorIntent: 'open', clientMutationId: randomUUID(),
                    }));
                    comments.set(sessionId, created.comment.id);
                }
                const definitionResult = validateWorkflowDefinition({ version: 1,
                    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
                    inputs: [{ name: 'reviewSession', valueType: 'json', required: true, inputType: { hostType: 'session' } },
                        { name: 'reviewCommentId', valueType: 'string', required: true }],
                    blocks: [{ kind: 'action', id: 'comments', actionId: 'reviews.comments.list', input: {
                        sessionId: { kind: 'input', name: 'reviewSession', path: ['sessionId'] },
                    } }, { kind: 'action', id: 'verdict', actionId: 'reviews.comments.setDisposition', input: {
                        workspace: { kind: 'literal', value: workspace }, commentId: { kind: 'input', name: 'reviewCommentId' },
                        expectedServerRevision: { kind: 'literal', value: 1 }, disposition: { kind: 'literal', value: 'blocking' },
                        clientMutationId: { kind: 'input', name: 'reviewCommentId' },
                    } }, { kind: 'action', id: 'after-verdict', actionId: 'reviews.comments.setDisposition', input: {
                        workspace: { kind: 'literal', value: workspace }, commentId: { kind: 'input', name: 'reviewCommentId' },
                        expectedServerRevision: { kind: 'literal', value: 2 }, disposition: { kind: 'literal', value: 'blocking' },
                        clientMutationId: { kind: 'literal', value: 'revoke-after-prepare' },
                    } }],
                });
                const definition = definitionResult.normalizedDefinition;
                if (!definition) throw new Error(JSON.stringify(definitionResult.issues));
                const childRef = randomUUID();
                const parent = nested ? validateWorkflowDefinition({ version: 1, defaults: definition.defaults, blocks: [
                    { kind: 'workflow', id: 'review-b', workflowRef: childRef, input: { reviewSession: { kind: 'literal', value: address },
                        reviewCommentId: { kind: 'literal', value: comments.get(targetId)! } } },
                    { kind: 'workflow', id: 'review-c', workflowRef: childRef, input: { reviewSession: { kind: 'literal', value: siblingAddress },
                        reviewCommentId: { kind: 'literal', value: comments.get(siblingId)! } } },
                ] }).normalizedDefinition : definition;
                if (!parent) throw new Error('invalid_nested_review_workflow_fixture');
                const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: parent,
                    context: { source: { kind: 'inline' }, inputs: nested ? {} : { reviewSession: address, reviewCommentId: comments.get(targetId)! }, machineId,
                        executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                        origin: { kind: 'direct', ...(origin !== 'originless' ? { originSessionId: originId } : {}) },
                        authorization: { principal: { kind: 'host' } } },
                    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true,
                        resolveSessionTarget: async value => [address, siblingAddress].find(candidate => JSON.stringify(value) === JSON.stringify(candidate))
                            ? { address: JSON.stringify(value) === JSON.stringify(address) ? address : siblingAddress, machineId } : null,
                        readWorkflowDefinition: async ref => ref.kind === 'artifact' && ref.artifactId === childRef
                            ? { definition, sourceKey: childRef } : null,
                        readActionContract: async id => {
                            if (id !== 'reviews.comments.list' && id !== 'reviews.comments.setDisposition') return null;
                            const spec = getActionSpec(id);
                            return { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.inputSchema, { target: 'draft-7' })),
                                outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(spec.outputSchema, { target: 'draft-7' })) };
                        },
                    } });
                if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
                const runId = randomUUID();
                const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                    ...runSealMode, binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId }, acceptedSnapshot: accepted.snapshot,
                }));
                await db.automationRun.create({ data: { id: runId, accountId: account.id, originKind: 'direct', causeKind: null,
                    ...(origin !== 'originless' ? { originSessionId: originId } : {}), scheduledAt: new Date(), dueAt: new Date(),
                    workflowCustodyState: 'pending', workflowAcceptedSnapshotEnvelope: envelope, assignments: { create: { machineId } },
                    workflowDataKeyEnvelopes: { create: runKeys.recipientKeyEnvelopes.map(entry => ({
                        recipientAccountId: entry.recipientAccountId, encryptedDataKey: new Uint8Array(privacyKit.decodeBase64(entry.encryptedDataKey)),
                        recipientContentPublicKeyFingerprint: entry.recipientContentPublicKeyFingerprint,
                    })) } } });
                const rootId = randomUUID();
                const invocationId = randomUUID();
                const siblingInvocationId = randomUUID();
                const verdictInvocationId = randomUUID();
                const siblingVerdictInvocationId = randomUUID();
                const revocationInvocationId = randomUUID();
                const childFrameId = randomUUID();
                const siblingFrameId = randomUUID();
                const actionRequestId = `${runId}/${invocationId}/0`;
                const rows = nested ? [
                    { id: rootId, parentRecordId: null, memberOrdinal: '0', blockId: '$root', blockKind: 'root', input: {}, scope: [] },
                    { id: childFrameId, parentRecordId: rootId, memberOrdinal: '0', blockId: 'review-b', blockKind: 'workflow', input: { reviewSession: address, reviewCommentId: comments.get(targetId)! }, scope: [] },
                    { id: invocationId, parentRecordId: childFrameId, memberOrdinal: '0', blockId: 'comments', blockKind: 'action', input: undefined,
                        scope: [{ kind: 'workflow', blockId: 'review-b' }] },
                    { id: verdictInvocationId, parentRecordId: childFrameId, memberOrdinal: '1', blockId: 'verdict', blockKind: 'action', input: undefined,
                        scope: [{ kind: 'workflow', blockId: 'review-b' }] },
                    { id: revocationInvocationId, parentRecordId: childFrameId, memberOrdinal: '2', blockId: 'after-verdict', blockKind: 'action', input: undefined,
                        scope: [{ kind: 'workflow', blockId: 'review-b' }] },
                    { id: siblingFrameId, parentRecordId: rootId, memberOrdinal: '1', blockId: 'review-c', blockKind: 'workflow', input: { reviewSession: siblingAddress, reviewCommentId: comments.get(siblingId)! }, scope: [] },
                    { id: siblingInvocationId, parentRecordId: siblingFrameId, memberOrdinal: '0', blockId: 'comments', blockKind: 'action', input: undefined,
                        scope: [{ kind: 'workflow', blockId: 'review-c' }] },
                    { id: siblingVerdictInvocationId, parentRecordId: siblingFrameId, memberOrdinal: '1', blockId: 'verdict', blockKind: 'action', input: undefined,
                        scope: [{ kind: 'workflow', blockId: 'review-c' }] },
                ] : [
                    { id: rootId, parentRecordId: null, memberOrdinal: '0', blockId: '$root', blockKind: 'root', input: { reviewSession: address, reviewCommentId: comments.get(targetId)! }, scope: [] },
                    { id: invocationId, parentRecordId: rootId, memberOrdinal: '0', blockId: 'comments', blockKind: 'action', input: undefined, scope: [] },
                    { id: verdictInvocationId, parentRecordId: rootId, memberOrdinal: '1', blockId: 'verdict', blockKind: 'action', input: undefined, scope: [] },
                ];
                const verdictInput = (sessionId: string) => ({ workspace, commentId: comments.get(sessionId)!, expectedServerRevision: 1,
                    disposition: 'blocking' as const, clientMutationId: comments.get(sessionId)! });
                const revokedVerdictInput = { ...verdictInput(targetId), expectedServerRevision: 2, clientMutationId: 'revoke-after-prepare' };
                for (const [sequence, row] of rows.entries()) {
                    const { id, parentRecordId, memberOrdinal } = row;
                    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1',
                        invocationPath: { blockId: row.blockId, scope: row.scope },
                        blockKind: row.blockKind, attempt: '0', logicalInvocationRecordId: id,
                        ...(row.blockKind === 'workflow' ? { container: { kind: 'body', nextBlockOrdinal: '0', frameInputs: row.input } } : {}),
                        ...(row.input ? { input: row.input } : { execution: { kind: 'action',
                            actionId: row.blockId === 'verdict' || row.blockId === 'after-verdict' ? 'reviews.comments.setDisposition' : 'reviews.comments.list',
                            actionRequestId: `${runId}/${id}/0`, localInputId: id, input: row.blockId === 'after-verdict' ? revokedVerdictInput : row.blockId === 'verdict'
                                ? verdictInput(id === siblingVerdictInvocationId ? siblingId : targetId)
                                : { sessionId: id === siblingInvocationId ? siblingId : targetId } } }),
                    });
                    await db.workflowRunInvocation.create({ data: { id, runId, sequence: BigInt(sequence), parentRecordId, memberOrdinal: BigInt(memberOrdinal),
                        attempt: 0n, contentRevision: 0n, lifecycle: 'running',
                        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ ...runSealMode, progress,
                            binding: { v: 1, purpose: 'invocation_progress', accountId: account.id, runId, recordId: id,
                                sequence: String(sequence), parentRecordId, memberOrdinal, attempt: '0' } })) } });
                }
                const readKeyCensus = async (id: string) => {
                    const key = await db.workflowRunDataKeyEnvelope.findUnique({ where: { runId_recipientAccountId: { runId: id, recipientAccountId: account.id } } });
                    const encryptedDataKey = key ? privacyKit.encodeBase64(key.encryptedDataKey) : null;
                    return WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: id, ownerAccountId: account.id, visibleTeamId: null,
                        encryptionMode: mode, access: 'owner', ownerAccountCurrentness: encryption.witness,
                        dataEncryptionKey: encryptedDataKey, callerDataEncryptionKey: encryptedDataKey, recipients: [] });
                };
                const runs = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => account.id,
                    resolveEncryption: async () => encryption,
                    definitions: { get: unused }, normalizeAbsolutePath: path => path.startsWith('/') ? path : null, randomBytes,
                    storage: { execute: async operation => {
                        if (operation.operation === 'invocations.list' || operation.operation === 'invocations.get') {
                            const rows = await db.workflowRunInvocation.findMany({ where: { runId: operation.runId,
                                ...(operation.operation === 'invocations.get' ? { id: operation.invocationId } : {}) }, orderBy: { sequence: 'asc' } });
                            const index = (row: typeof rows[number]) => WorkflowRunInvocationIndexV1Schema.parse({ id: row.id, runId: row.runId,
                                parentRecordId: row.parentRecordId, lifecycle: row.lifecycle,
                                sequence: row.sequence.toString(), memberOrdinal: row.memberOrdinal.toString(), attempt: row.attempt.toString(),
                                contentRevision: row.contentRevision.toString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
                            if (operation.operation === 'invocations.get') {
                                const row = rows[0];
                                if (!row) throw new Error('invocation_not_found');
                                return { invocation: { index: index(row), contentEnvelope: row.contentEnvelope, parentRevision: 0 } };
                            }
                            return { invocations: rows.map(index), parentRevision: 0, keyCensus: await readKeyCensus(operation.runId),
                                progressEnvelopesByInvocationId: Object.fromEntries(rows.map(row => [row.id, row.contentEnvelope])) };
                        }
                        if (operation.operation !== 'get') throw new Error('unexpected_storage_operation');
                        const row = await db.automationRun.findUniqueOrThrow({ where: { id: operation.runId } });
                        return { run: WorkflowRunSummaryV1Schema.parse({ id: row.id, sourceArtifactId: null, ownerAccountId: account.id, visibleTeamId: null,
                            origin: accepted.snapshot.origin, state: 'queued', revision: 0, machineId, workflowCustodyState: 'pending', originDeliveryAckRevision: null,
                            availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
                            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }),
                            acceptedEnvelope: row.workflowAcceptedSnapshotEnvelope, checkpointEnvelope: null, resultEnvelope: null,
                            keyCensus: await readKeyCensus(row.id) };
                    } } });
                let producedPrincipal: ReviewCommentPrincipalHeaderV1 | undefined;
                const executor = createActionExecutor(actionDependencies({ workflowAction: args => runs.execute(args),
                    resolveSessionReference: async ({ sessionId }) => {
                        const access = await resolveSessionAccessForOperation(db, { accountId: account.id, sessionId: sessionId ?? '',
                            authentication: createPresentUserSessionAccessAuthentication(), capability: 'readTranscript' });
                        return access.status === 'allowed' ? { kind: 'unique', address: { serverId: 'home', sessionId: sessionId! } } : { kind: 'none' };
                    },
                    reviewCommentAction: ({ actionId, input, reviewCommentPrincipal }) => {
                        producedPrincipal = reviewCommentPrincipal;
                        return transport(actionId, input, reviewCommentPrincipal ? { principal: reviewCommentPrincipal } : undefined);
                    },
                }));
                const context = {
                    surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: account.id,
                    ...(origin !== 'originless' ? { defaultSessionId: originId } : {}),
                    actionRequestId, actionCaller: { kind: 'workflowRun', runId, authorization: accepted.snapshot.authorization },
                } as const;
                const result = await executor.execute('reviews.comments.list', { sessionId: targetId }, context);
                expect(result, JSON.stringify({ requests, result })).toMatchObject({ ok: true, result: { items: [{ id: comments.get(targetId), sessionId: targetId }] } });
                expect(requests).toContainEqual({ path: '/v1/reviews/comments', status: 200 });
                if (!producedPrincipal) throw new Error('workflow_principal_not_produced');
                const firstPrincipal = producedPrincipal;
                if (nested) {
                    expect(await executor.execute('reviews.comments.list', { sessionId: siblingId }, context))
                        .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                    const sibling = await executor.execute('reviews.comments.list', { sessionId: siblingId }, {
                        ...context, actionRequestId: `${runId}/${siblingInvocationId}/0`,
                    });
                    expect(sibling, JSON.stringify(requests)).toMatchObject({ ok: true,
                        result: { items: [{ id: comments.get(siblingId), sessionId: siblingId }] } });
                    await expect(transport('reviews.comments.list', { sessionId: siblingId }, { principal: firstPrincipal }))
                        .rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                }
                const verdictContext = { ...context, actionRequestId: `${runId}/${verdictInvocationId}/0` };
                const verdict = await executor.execute('reviews.comments.setDisposition', verdictInput(targetId), verdictContext);
                expect(verdict, JSON.stringify(requests)).toMatchObject({ ok: true, result: { comment: {
                    id: comments.get(targetId), sessionId: targetId, serverRevision: 2, dispositions: { [`workflow:${runId}`]: 'blocking' },
                } } });
                // A repeated stale mutation retains the incumbent CAS contract;
                // Workflow rejoin observes the committed result before reissue.
                const replay = await executor.execute('reviews.comments.setDisposition', verdictInput(targetId), verdictContext);
                expect(replay, JSON.stringify({ requests, replay }))
                    .toMatchObject({ ok: false });
                expect(requests.at(-1)).toMatchObject({ status: 409, error: 'review_comment_conflict' });
                expect(await db.reviewComment.findUniqueOrThrow({ where: { id: comments.get(targetId)! }, select: { serverRevision: true } }))
                    .toEqual({ serverRevision: 2 });
                expect(await executor.execute('reviews.comments.list', { sessionId: targetId }, context))
                    .toMatchObject({ ok: true, result: { items: [{ id: comments.get(targetId), serverRevision: 2 }] } });
                if (nested) {
                    const crossChild = await executor.execute('reviews.comments.setDisposition', verdictInput(siblingId), verdictContext);
                    expect(crossChild).toMatchObject({ ok: false });
                    expect(requests.at(-1)).toMatchObject({ status: 400, error: 'review_comment_permission_denied' });
                    expect(await db.reviewComment.findUniqueOrThrow({ where: { id: comments.get(siblingId)! }, select: { serverRevision: true } }))
                        .toEqual({ serverRevision: 1 });
                    const siblingVerdict = await executor.execute('reviews.comments.setDisposition', verdictInput(siblingId), {
                        ...context, actionRequestId: `${runId}/${siblingVerdictInvocationId}/0`,
                    });
                    expect(siblingVerdict, JSON.stringify(requests)).toMatchObject({ ok: true, result: { comment: {
                        id: comments.get(siblingId), sessionId: siblingId, serverRevision: 2,
                    } } });
                }
                // Re-enter Home with the exact producer's signed scope. These
                // cases prove the protected consumer, beyond Protocol's guard.
                await expect(transport('reviews.comments.list', { sessionId: unrelatedId }, { principal: firstPrincipal }))
                    .rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                await expect(transport('reviews.comments.list', { sessionId: targetId }, {
                    principal: { ...firstPrincipal, actor: { kind: 'workflow', runId: randomUUID() } },
                })).rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                if (!firstPrincipal.workflowScope) throw new Error('workflow_invocation_scope_not_produced');
                await expect(transport('reviews.comments.list', { sessionId: targetId }, {
                    principal: { ...firstPrincipal, workflowScope: { ...firstPrincipal.workflowScope,
                        invocationId: nested ? siblingInvocationId : verdictInvocationId } },
                })).rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                await expect(transport('reviews.comments.list', { sessionId: targetId }, {
                    principal: { ...firstPrincipal, workflowScope: { ...firstPrincipal.workflowScope,
                        actionRequestId: `${runId}/${invocationId}/1` } },
                })).rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                await expect(transport('reviews.comments.list', { sessionId: unrelatedId }, {
                    principal: { actor: { kind: 'agent', agentId: 'test', sessionId: originId } },
                })).rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                signerMachineId = otherMachineId;
                await expect(transport('reviews.comments.list', { sessionId: targetId }, { principal: firstPrincipal }))
                    .rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                signerMachineId = machineId;
                tamperSignedScope = true;
                await expect(transport('reviews.comments.list', { sessionId: targetId }, { principal: firstPrincipal }))
                    .rejects.toMatchObject({ code: 'review_comment_permission_denied' });
                tamperSignedScope = false;
                if (mode === 'e2ee') {
                    const before = requests.length;
                    revokeBeforeCommit = true;
                    const revoked = await executor.execute('reviews.comments.setDisposition', revokedVerdictInput, {
                        ...context, actionRequestId: `${runId}/${revocationInvocationId}/0`,
                    });
                    expect(revoked, JSON.stringify(requests.slice(before))).toMatchObject({ ok: false });
                    expect(requests.slice(before)).toEqual([
                        { path: '/v1/reviews/comments/mutations/prepare', status: 200 },
                        { path: '/v1/reviews/comments/mutations/commit', status: 400, error: 'review_comment_permission_denied' },
                    ]);
                    expect(await db.reviewComment.findUniqueOrThrow({ where: { id: comments.get(targetId)! }, select: { serverRevision: true } }))
                        .toEqual({ serverRevision: 2 });
                }
                await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: targetId, accountId: account.id } });
                await expect(transport('reviews.comments.list', { sessionId: targetId }, { principal: firstPrincipal }))
                    .rejects.toMatchObject({ code: 'review_comment_permission_denied' });
            } finally {
                axios.defaults.adapter = previousAdapter;
            }
        }, { authentication: 'real' });
    });
});
