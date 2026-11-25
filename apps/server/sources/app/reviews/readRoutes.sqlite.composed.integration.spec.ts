import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ReviewListResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { createAccountServerActionDeps } from '../../../../cli/src/api/accountServerActionDeps';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { registerReviewReadRoutes } from './readRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { createReviewRecordPortV1, ReviewRoundBindingV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { readReviewStartActionResultV1 } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { createCredentialedAccountArtifactStore, createAcknowledgedAccountArtifactTransport } from '../../../../cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { createReviewRunCommentService } from '../../../../cli/src/agent/executionRuns/profiles/review/reviewComments';
import { ReviewProfile } from '../../../../cli/src/agent/executionRuns/profiles/review/ReviewProfile';
import { finishExecutionRun } from '../../../../cli/src/agent/runtime/bridges/executionRun/finishExecutionRun';
import { resolveExecutionRunRuntimeBackendTarget, resolveExecutionRunRuntimeBackendId } from '../../../../cli/src/agent/runtime/bridges/executionRun/backendTargets';
import type { ExecutionRunState } from '../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { createCliActionDeps } from '../../../../cli/src/session/actions/createCliActionDeps';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { registerReviewHumanRoutes } from './reviewHumanRoutes';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { inTx } from '@/storage/inTx';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { setTeamPolicyInTx } from '@/app/teams/policy';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

describe('Review read Actions through authenticated HTTP', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let app: AppFastify;
    let origin: string;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-review-read-actions-', initAuth: true, initEncrypt: true });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableAuthentication(app);
        registerReviewReadRoutes(app);
        artifactsRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerProjectAccountRowRoutes(app);
        registerSessionListingRoutes(app);
        registerReviewHumanRoutes(app);
        featuresRoutes(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
        origin = `http://127.0.0.1:${address.port}`;
    }, 180_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });

    it('starts a clean engine Review through the Action and reloads its completed empty record through authenticated HTTP', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', seq: 7 } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const recordsFor = () => createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(
            createCredentialedAccountArtifactStore({ token, encryption: null })));
        await runWithServerHttpBaseUrl(origin, async () => {
            const records = recordsFor();
            const starts: ExecutionRunState[] = [];
            const executor = createActionExecutor({
                ...createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }),
                reviewRecords: () => records,
                // The daemon's inventory/start RPC is the OS process boundary; no vendor is launched.
                reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex', enabled: true,
                    capabilities: { structuredNarration: true } }] }),
                executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'clean-review-machine' }),
                executionRunStart: async (sessionId, input) => {
                    const request = ExecutionRunStartRequestSchema.parse(input);
                    const backendTarget = resolveExecutionRunRuntimeBackendTarget(request.backendTarget);
                    if (!backendTarget) throw new Error('Expected the admitted engine target');
                    const run: ExecutionRunState = { runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID(), sessionId,
                        depth: 0, intent: 'review', backendId: resolveExecutionRunRuntimeBackendId(backendTarget), backendTarget,
                        instructions: request.instructions ?? '', permissionMode: request.permissionMode,
                        retentionPolicy: request.retentionPolicy, runClass: request.runClass, ioMode: request.ioMode,
                        status: 'running', startedAtMs: Date.now(), intentInput: request.intentInput };
                    starts.push(run);
                    return { runId: run.runId, callId: run.callId, sidechainId: run.sidechainId };
                },
            });
            const started = await executor.execute('review.start', { sessionId: session.id, scope: 'repository',
                instructions: 'Review the repository.', reviewers: [{ kind: 'engine', engineId: 'codex' }] }, {
                surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true, defaultSessionId: session.id,
                callerPermissionMode: 'read-only', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
                agentStartContext: { caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    baseline: { machineId: 'clean-review-machine', directory: harness.baseDir }, roles: {}, ledSubtreeSessionIds: [],
                    workDepthLimit: 4, callerPermissionCeiling: 'read-only' },
            });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
            if (!started.ok) throw new Error(started.error);
            const receipt = readReviewStartActionResultV1(started.result, { reviewers: [{ kind: 'engine', engineId: 'codex' }] });
            expect(receipt.kind).toBe('native');
            if (receipt.kind !== 'native') throw new Error('Expected the native Review admission receipt');
            const binding = ReviewRoundBindingV1Schema.parse(receipt.reviewRound);
            expect(starts).toHaveLength(1);
            const run = starts[0]!;
            expect(run.intentInput).toMatchObject({ reviewRound: binding, reviewRoundSettlement: 'execution' });
            const comments = createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId: 'clean-review-machine', path: harness.baseDir } }, reviewRecords: records,
                execute: async () => { throw new Error('A clean result must not create a Review comment'); } });
            const payload = { reviewOutcome: 'complete', summary: 'No findings.', findings: [] };
            const completion = ReviewProfile.onBoundedComplete({ start: run, rawText: JSON.stringify(payload), finishedAtMs: Date.now() });
            expect(completion.status).toBe('succeeded');
            const runs = new Map([[run.runId, run]]);
            expect(await finishExecutionRun({ runId: run.runId,
                next: { status: completion.status, summary: completion.summary, finishedAtMs: Date.now() },
                toolResult: { output: completion.toolResultOutput, meta: completion.toolResultMeta }, structuredMeta: completion.structuredMeta,
                runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'claude', sendAcp: async () => {},
                enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
                reviewComments: comments })).toBe(true);
            expect(runs.get(run.runId)?.status).toBe('succeeded');
            expect(await db.reviewComment.count({ where: { reviewId: binding.reviewId } })).toBe(0);
            // Discard the port and Action executor: all following reads cross HTTP from fresh transport owners.
            expect(await recordsFor().read(binding.reviewId)).toMatchObject({ reviewId: binding.reviewId,
                rounds: [{ ordinal: 1, state: 'completed', runs: [{ kind: 'execution', runId: run.runId }] }] });
            const reloaded = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
            expect(await reloaded.execute('review.get', { reviewId: binding.reviewId },
                { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true }))
                .toMatchObject({ ok: true, result: { review: { reviewId: binding.reviewId, state: 'completed',
                    sourceSessionId: session.id, sourceSessionSeq: 7, counts: { total: 0, needsDecision: 0 } } } });
        });
    });

    it.each((['private_default', 'team_default', 'team_required'] as const).flatMap(reviewCreationPolicy =>
        (['engine', 'person'] as const).map(reviewerKind => ({ reviewCreationPolicy, reviewerKind }))))(
        'applies the selected Session Project policy through review.start ($reviewCreationPolicy/$reviewerKind)', async ({ reviewCreationPolicy, reviewerKind }) => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
            await makeShareEligibleForTest(owner.id, [outsider.id]);
            const team = await db.team.create({ data: { name: 'Action Review Team', reviewCreationPolicy, externalSharingPolicy: 'disabled' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
                serverId: origin, requestKey: randomUUID(), name: 'Action Project', owner: { kind: 'team', teamId: team.id }, audience: [],
            }));
            if (!source.ok) throw new Error(source.error);
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const headers = { authorization: `Bearer ${token}` };
            const workspaceId = randomUUID();
            const machineId = randomUUID();
            const key = { kind: 'workspace-ref', serverId: origin, id: workspaceId };
            const graphKey = { kind: 'relationship-graph' };
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers, payload: {
                mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: {
                    id: workspaceId, serverId: origin, machineId, rootPath: harness.baseDir, createdAtMs: 1,
                    source: { sourceId: source.source.id, revision: source.source.revision },
                } } } }, { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } }],
                expectedRefs: [], topologyChange: true,
            } })).json()).toMatchObject({ status: 'updated' });
            const metadata = { path: harness.baseDir, host: 'fixture', machineId, workspaceId, projectId: workspaceId };
            const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
            if (!ownerMetadata.ok) throw new Error('Expected canonical owner metadata');
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
                metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
                ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)) } });
            await runWithServerHttpBaseUrl(origin, async () => {
                const credentials = { token, encryption: null };
                const deps = createCliActionDeps({ token, credentials, sessionId: session.id, mode: 'plain', ctx: null,
                    serverId: origin, serverIdentityId: origin, serverHttpBaseUrl: origin });
                const executor = createActionExecutor({
                    ...createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }),
                    sessionStatusGet: deps.sessionStatusGet,
                    projectWorkspaceRefs: deps.projectWorkspaceRefs,
                    reviewRecords: deps.reviewRecords,
                    // Only the external daemon process is substituted; Account/Session reads and Record writes stay real.
                    reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex', enabled: true,
                        capabilities: { structuredNarration: true } }] }),
                    executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: machineId }),
                    executionRunStart: async () => ({ runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID() }),
                });
                const reviewers = reviewerKind === 'engine' ? [{ kind: 'engine' as const, engineId: 'codex' }]
                    : [{ kind: 'person' as const, principal: { kind: 'account' as const, accountId: owner.id }, required: true }];
                const input = { sessionId: session.id, scope: 'repository' as const, instructions: 'Review the repository.', reviewers };
                const context = {
                    surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true,
                    defaultSessionId: session.id, defaultSessionMachineId: machineId, callerPermissionMode: 'read-only',
                    sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
                    agentStartContext: { caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                        baseline: { machineId, directory: harness.baseDir }, roles: {}, ledSubtreeSessionIds: [],
                        workDepthLimit: 4, callerPermissionCeiling: 'read-only' },
                } as const;
                const result = await executor.execute('review.start', input, context);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                if (!result.ok) throw new Error(result.error);
                const receipt = readReviewStartActionResultV1(result.result, { reviewers });
                if (receipt.kind !== 'native' || !receipt.reviewRound) throw new Error('Expected the admitted Review');
                const artifactId = receipt.reviewRound.reviewId;
                expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({ projectSourceId: source.source.id });
                const grants = await db.artifactGrant.findMany({ where: { artifactId } });
                expect(grants).toMatchObject(reviewCreationPolicy === 'private_default' ? [] : [{ teamId: team.id,
                    accessLevel: 'edit', requiredByTeamPolicy: reviewCreationPolicy === 'team_required' }]);
                expect(grants).toHaveLength(reviewCreationPolicy === 'private_default' ? 0 : 1);
                const grant = { actorAccountId: owner.id, artifactId, principal: { kind: 'account' as const, accountId: outsider.id }, accessLevel: 'view' as const };
                expect(await inTx(tx => setArtifactAccessGrantInTx(tx, grant))).toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
                expect(await db.artifactGrant.findMany({ where: { artifactId } })).toEqual(grants);
                expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId: team.id, externalSharingPolicy: 'allowed' }))).toMatchObject({ ok: true });
                expect(await inTx(tx => setArtifactAccessGrantInTx(tx, grant))).toMatchObject({ ok: true });
                if (reviewCreationPolicy === 'team_required' && reviewerKind === 'engine') {
                    // A stamped but inaccessible checkout cannot turn the next Review into a private Record.
                    const missing = createSessionOwnerMetadataV1({ metadata: { ...metadata, workspaceId: randomUUID() } });
                    if (!missing.ok) throw new Error('Expected canonical owner metadata');
                    await db.session.update({ where: { id: session.id }, data: {
                        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(missing.ownerMetadata)),
                    } });
                    const before = await db.reviewMetadata.count();
                    expect(await executor.execute('review.start', input, context)).toMatchObject({
                        ok: false, errorCode: 'project_association_unavailable',
                    });
                    expect(await db.reviewMetadata.count()).toBe(before);
                }
            });
        });

    it.each(['plain', 'e2ee'] as const)('reads the admitted aggregate and refuses another Account (%s)', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode } });
        const outsider = await db.account.create({ data: { encryptionMode } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'direct', state: 'completed',
                currentRoundOrdinal: 1, startedAt: new Date(1000), finishedAt: new Date(2000) } } } });
        const executeFor = async (accountId: string) => {
            const token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
            return createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }))
                .execute('review.get', { reviewId }, { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true });
        };
        expect(await executeFor(owner.id)).toMatchObject({ ok: true, result: {
            review: { reviewId, currentRoundOrdinal: 1, state: 'completed', counts: { total: 0, needsDecision: 0 } },
            human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou: { needsYou: false } },
        } });
        expect(await executeFor(outsider.id)).toMatchObject({ ok: false, errorCode: 'review_not_found' });
    });

    it('reads persisted findings beyond one page and only the current requested-person verdict', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'workflow', state: 'completed',
                currentRoundOrdinal: 2, startedAt: new Date(1000), finishedAt: new Date(2000) } } } });
        // Persisted boundary fixtures: this read must count roots, independently of body paging and appearances.
        const findings = Array.from({ length: 51 }, (_, index) => {
            const id = randomUUID();
            return { id, accountId: owner.id, reviewId, findingIdentity: `finding-${index}`,
                threadId: id, state: 'open', reviewTriageStatus: index === 50 ? null : 'reject',
                flagsJson: '{}', anchorJson: '{}', snapshotEnvelopeJson: '{}', bodyEnvelopeJson: '{}',
                bodyVersion: 1, authorJson: '{}', editsJson: '[]', dispositionsJson: '{}', transitionsJson: '[]',
                serverRevision: 1, createdAt: BigInt(index), updatedAt: BigInt(index) };
        });
        await db.reviewComment.createMany({ data: findings });
        const pending = findings[50]!;
        await db.reviewCommentAppearance.createMany({ data: ['first', 'second'].map(reviewerId => ({
            reviewId, commentId: pending.id, roundOrdinal: 2, runId: 'review-run', reviewerId, sourceKey: reviewerId,
        })) });
        await db.reviewRequestedReviewer.create({ data: { reviewId, roundOrdinal: 2,
            principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true,
            eligibleAccounts: { create: { accountId: owner.id } } } });
        await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 1, accountId: owner.id, verdict: 'approve' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const read = () => executor.execute('review.get', { reviewId },
            { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true });
        expect(await read()).toMatchObject({ ok: true, result: {
            review: { state: 'completed', currentRoundOrdinal: 2, counts: { total: 51, needsDecision: 1 } },
            human: { roundOrdinal: 2, requests: [{ required: true, roundOrdinal: 2 }],
                verdicts: [{ roundOrdinal: 1, verdict: 'approve' }], needsYou: { requestedVerdict: true, needsYou: true } },
        } });
        await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 2, accountId: owner.id, verdict: 'request_changes' } });
        await db.reviewComment.update({ where: { id: pending.id }, data: { reviewTriageStatus: 'reject' } });
        expect(await read()).toMatchObject({ ok: true, result: {
            review: { state: 'completed', counts: { total: 51, needsDecision: 0 } },
            human: { verdicts: [{ roundOrdinal: 1, verdict: 'approve' }, { roundOrdinal: 2, verdict: 'request_changes' }],
                needsYou: { requestedVerdict: false, needsYou: false } },
        } });
    });

    it.each(['plain', 'e2ee'] as const)('reads only the caller’s demanded metadata page and authorized history (%s)', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode } });
        const outsider = await db.account.create({ data: { encryptionMode } });
        const workflowId = randomUUID();
        const make = async (accountId: string, sequence: number) => {
            const id = randomUUID();
            const at = new Date(sequence * 1000);
            await db.artifact.create({ data: { id, accountId, header: new Uint8Array(), body: new Uint8Array(),
                dataEncryptionKey: new Uint8Array(), createdAt: at, updatedAt: at } });
            await db.reviewMetadata.create({ data: { artifactId: id, workflowId, subjectKind: 'repository',
                sourceKind: 'workflow', state: 'completed', currentRoundOrdinal: 1, startedAt: at } });
            return id;
        };
        const previous = await make(owner.id, 1);
        const current = await make(owner.id, 2);
        const hidden = await make(outsider.id, 3);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const context = { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true } as const;
        const first = await executor.execute('reviews.list', { limit: 1, workflowId }, context);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { items: [{ reviewId: current, counts: { total: 0, needsDecision: 0 } }], cursor: expect.any(String) } });
        if (!first.ok) throw new Error('Expected owner read');
        const page = ReviewListResponseV1Schema.parse(first.result);
        expect(page.items).toHaveLength(1);
        const second = await executor.execute('reviews.list', { limit: 1, workflowId, cursor: page.cursor }, context);
        expect(second).toMatchObject({ ok: true, result: { items: [{ reviewId: previous }], cursor: null } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: current }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: previous, items: [] } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: hidden }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: null, items: [] } });
        const unauthenticated = await app.inject({ method: 'POST', url: '/v1/reviews/list', payload: { limit: 1 } });
        expect(unauthenticated.statusCode).toBe(401);
        const invalid = await app.inject({ method: 'POST', url: '/v1/reviews/list', headers: { authorization: `Bearer ${token}` },
            payload: { limit: 1, actorAccountId: outsider.id } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ error: 'review_comment_invalid_request' });
    });
});
