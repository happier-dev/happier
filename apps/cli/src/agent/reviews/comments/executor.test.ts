import { createHash } from 'node:crypto';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encryptWithDataKey, encodeBase64 } from '@/api/encryption';
import { sealReviewCommentSensitiveEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { REVIEW_ARTIFACT_KIND_V1, ReviewArtifactHeaderV1Schema, ReviewArtifactBodyV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';

import { createCliReviewCommentActionExecutorFromCredentials } from './executor';
import { ReviewCommentActionOutputSchemasV1 } from '@happier-dev/protocol/reviews/comments/actions';
import {
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    ReviewCommentPrincipalHeaderV1Schema,
    ReviewCommentPublicationTransportRequestV1Schema,
    ReviewCommentPrepareMutationRequestV1Schema,
    ReviewCommentCommitMutationRequestV1Schema,
    splitReviewCommentV1,
    openStoredReviewCommentV1,
    deriveReviewCommentStructuralMutationV1,
    type ReviewCommentV1,
    createReviewCommentPrincipalSigningInputV1,
    createReviewCommentPublicationSettlementRequestV1,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
    type ReviewCommentClaimPublicationDispatchResponseV1,
    type ReviewCommentPublicationPlanV1,
    type ReviewCommentPublicationTransportRequestV1,
} from '@happier-dev/protocol';

const axiosPostMock = vi.mocked(axios.post);

const plainEventStorageParams = {
    resolveAccountId: () => 'account-1',
    resolveAccountEncryptionMode: async () => 'plain' as const,
};

vi.mock('axios', () => ({
    default: {
        defaults: {},
        post: vi.fn(),
        get: vi.fn(),
        patch: vi.fn(),
    },
}));

/**
 * Every private plan string carries `PRIVATE-`, so one substring sweep over the
 * bytes axios actually received covers present and future request fields. The
 * canonical `happierCommentId` the Happier server already owns is excluded on
 * purpose: it is the row the server must arbitrate on.
 */
const publicationPlan: ReviewCommentPublicationPlanV1 = {
    target: {
        providerId: 'PRIVATE-provider',
        configuredAccountId: 'PRIVATE-connected-account',
        entryRef: {
            sourceId: 'PRIVATE-source',
            kindId: 'PRIVATE-entry-kind',
            collisionScope: 'PRIVATE-repository',
            entryId: 'PRIVATE-pull-request',
        },
        subtarget: null,
    },
    baseRevision: 'PRIVATE-base-revision',
    headRevision: 'PRIVATE-head-revision',
    entries: [{
        happierCommentId: 'comment-1',
        expectedServerRevision: 1,
        anchor: { kind: 'line', filePath: 'PRIVATE-source/file.ts', line: 4 },
        snapshot: {
            kind: 'text',
            selectedLines: ['PRIVATE-selected-code'],
            beforeContext: ['PRIVATE-before-context'],
            afterContext: ['PRIVATE-after-context'],
            selectedLinesHash: 'PRIVATE-selected-hash',
            contextWindowHash: 'PRIVATE-context-hash',
            capturedAt: 1,
            fileLength: 5,
            source: 'workingTree',
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        },
        body: 'PRIVATE-review-body',
    }],
    verdict: { kind: 'comment', body: 'PRIVATE-verdict-body' },
};

function postedTransportRequest(callIndex: number): ReviewCommentPublicationTransportRequestV1 {
    return ReviewCommentPublicationTransportRequestV1Schema.parse(axiosPostMock.mock.calls[callIndex]?.[1]);
}

/** The exact server reply for a dispatch claim of the request axios received. */
function dispatchResponseFor(body: unknown): unknown {
    const request = ReviewCommentPublicationTransportRequestV1Schema.parse(body);
    return {
        disposition: 'dispatch',
        dispatchToken: 'dispatch-token-1',
        publicationPlanId: request.publicationPlanId,
        entries: request.entries.map(({ happierCommentId, publicationCorrelationId }) => ({
            happierCommentId,
            publicationCorrelationId,
        })),
        verdict: request.verdict,
        instructions: {
            entries: request.entries.map(() => 'dispatch'),
            verdict: request.verdict === null ? null : 'dispatch',
        },
        priorResult: null,
    };
}

function settlementResponseFor(body: unknown): unknown {
    const request = ReviewCommentPublicationTransportRequestV1Schema.parse(body);
    return {
        disposition: 'reconcile',
        dispatchToken: null,
        publicationPlanId: request.publicationPlanId,
        entries: request.entries.map(({ happierCommentId, publicationCorrelationId }) => ({
            happierCommentId,
            publicationCorrelationId,
        })),
        verdict: request.verdict,
        instructions: {
            entries: request.entries.map(() => 'confirmed'),
            verdict: request.verdict === null ? null : 'confirmed',
        },
        priorResult: request.settlement?.result ?? null,
    };
}

describe('createCliReviewCommentActionExecutorFromCredentials', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([true, false])('reads shared Review content through the admitted Artifact codec (explicit Review scope: %s)', async scoped => {
        const credentials = { token: 'recipient-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(19) } };
        const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
        if (resource.mode !== 'e2ee') throw new Error('Expected encrypted resource fixture');
        const source: ReviewCommentV1 = { v: 1, id: 'shared-comment', reviewId: 'shared-review', accountId: 'owner',
            anchor: { kind: 'file', filePath: 'private.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'private shared finding',
            bodyVersion: 1, edits: [], author: { kind: 'user', userId: 'owner' }, state: 'open', flags: {}, dispositions: {},
            threadId: 'shared-comment', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 };
        const { structural, sensitive } = splitReviewCommentV1(source);
        const plain = sealReviewCommentSensitiveEnvelopeV1({ structural, sensitive, mode: 'plain' });
        if (plain.t !== 'plain') throw new Error('Expected logical fixture');
        const encode = (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey));
        const artifact = { id: source.reviewId, ownerAccountId: 'owner', access: 'view', publicAudience: 'none', encryptionMode: 'e2ee',
            dataEncryptionKey: resource.dataEncryptionKey,
            header: encode(ReviewArtifactHeaderV1Schema.parse({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: source.reviewId, title: 'Review' })),
            body: encode({ body: JSON.stringify(ReviewArtifactBodyV1Schema.parse({ v: 1, rounds: [] })) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const stored = { v: 1, structural, sensitiveEnvelope: { t: 'encrypted', c: encode(plain.v) } };
        const reads: string[] = [];
        vi.mocked(axios.get).mockReset().mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            reads.push(path);
            if (path === `/v1/artifacts/${source.reviewId}`) return { status: 200, data: artifact };
            if (path === `/v1/reviews/comments/${source.id}`) return { status: 200, data: { comment: stored } };
            throw new Error(`Unexpected resource read: ${path}`);
        });
        try {
            const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials, resolveAccountId: () => 'recipient',
                resolveAccountEncryptionMode: async () => { throw new Error('Comment reads use the admitted resource mode'); } });
            await expect(execute('reviews.comments.get', { commentId: source.id, ...(scoped ? { reviewId: source.reviewId } : {}) }))
                .resolves.toEqual({ comment: source });
            expect(reads).toEqual(scoped
                ? [`/v1/artifacts/${source.reviewId}`, `/v1/reviews/comments/${source.id}`]
                : [`/v1/reviews/comments/${source.id}`, `/v1/artifacts/${source.reviewId}`]);
        } finally { vi.mocked(axios.get).mockReset(); }
    });

    it('creates an E2EE comment through authorized structure and sealed content without leaking sensitive HTTP bytes', async () => {
        const input = {
            projectId: 'project-1', anchor: publicationPlan.entries[0]!.anchor,
            snapshot: publicationPlan.entries[0]!.snapshot, body: publicationPlan.entries[0]!.body,
            clientMutationId: 'mutation-1', metadata: { tags: ['PRIVATE-tag'] },
        };
        const comment: ReviewCommentV1 = {
            v: 1, id: 'comment-1', accountId: 'account-1', projectId: input.projectId,
            anchor: input.anchor, snapshot: input.snapshot, body: input.body, metadata: input.metadata,
            bodyVersion: 1, edits: [], author: { kind: 'user', userId: 'account-1' },
            state: 'open', flags: {}, dispositions: {}, threadId: 'comment-1', evidence: [], transitions: [],
            createdAt: 100, updatedAt: 100, serverRevision: 1,
        };
        const canonicalComment = comment;
        const structural = splitReviewCommentV1(canonicalComment).structural;
        axiosPostMock.mockImplementation(async (url, body) => {
            if (String(url).endsWith('/mutations/prepare')) {
                const request = ReviewCommentPrepareMutationRequestV1Schema.parse(body);
                return { status: 200, data: { v: 1, receipt: 'receipt-1', request,
                    records: [{ structural, event: { eventId: 'event-1', commentId: structural.id,
                        accountId: structural.accountId, projectId: structural.projectId, eventKind: 'created',
                        actor: structural.author, createdAt: 100, serverRevision: 1,
                        event: { clientMutationId: input.clientMutationId } } }], replayed: false, failed: [] } };
            }
            const request = ReviewCommentCommitMutationRequestV1Schema.parse(body);
            const stored = { v: 1 as const, structural, sensitiveEnvelope: request.records[0]!.sensitiveEnvelope };
            expect(openStoredReviewCommentV1({ stored, mode: 'e2ee', material: {
                type: 'legacy', secret: new Uint8Array(32).fill(5),
            } })).toMatchObject({ status: 'available', comment: { body: input.body, metadata: input.metadata } });
            return { status: 200, data: { v: 1, comments: [stored], replayed: false, failed: [] } };
        });
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) } },
            resolveAccountId: () => 'account-1', resolveAccountEncryptionMode: async () => 'e2ee',
        });
        const result = ReviewCommentActionOutputSchemasV1['reviews.comments.create'].parse(await executor('reviews.comments.create', input));
        // Create omitted optional evidence; the canonical sensitive mutation
        // preserves that absence, which has the same no-evidence meaning as [].
        expect({ ...result.comment, evidence: result.comment.evidence ?? [] }).toMatchObject(canonicalComment);
        expect(axiosPostMock).toHaveBeenCalledTimes(2);
        const bytes = JSON.stringify(axiosPostMock.mock.calls.map((call) => call[1]));
        for (const value of [input.body, 'PRIVATE-selected-code', 'PRIVATE-tag']) expect(bytes).not.toContain(value);
    });

    it('revalidates the original host principal before encrypted commit and rejects a substituted logical effect before prepare', async () => {
        const input = { workspace: { machineId: 'machine-1', path: '/repo' }, runId: 'run-1',
            anchor: { kind: 'run', runId: 'run-1' }, snapshot: { kind: 'none', capturedAt: 1 },
            body: 'PRIVATE-body', clientMutationId: 'mutation-1' };
        const principal = ReviewCommentPrincipalHeaderV1Schema.parse({
            actor: { kind: 'agent', agentId: 'codex', sessionId: 'session-1' },
            currentIntent: { v: 1, kind: 'review_findings_materialization', actionId: 'reviews.comments.create',
                effectBodySha256Base64Url: createHash('sha256').update(stringifyReviewCommentPrincipalCanonicalJsonV1(input)).digest('base64url'),
                sessionId: 'session-1', runId: 'run-1', callId: 'call-1', agentId: 'codex', workspace: input.workspace },
        });
        let checks = 0;
        axiosPostMock.mockImplementation(async (_url, body) => {
            const request = ReviewCommentPrepareMutationRequestV1Schema.parse(body);
            const result = deriveReviewCommentStructuralMutationV1({ mutation: request.mutation, accountId: 'account-1',
                actor: principal.actor, current: [], runtime: { now: () => 100, createId: (prefix) => `${prefix}-1` } });
            return { status: 200, data: { v: 1, receipt: 'receipt-1', request, ...result, replayed: false } };
        });
        const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) } },
            resolveAccountId: () => 'account-1', resolveAccountEncryptionMode: async () => 'e2ee',
            resolvePrincipalSigningContext: async () => ({ machineId: 'machine-1', installationId: 'installation-1',
                privateKeyBase64Url: Buffer.from(keys.secretKey).toString('base64url') }),
            assertPrincipalCurrent: (observed) => {
                expect(observed).toBe(principal);
                if (++checks === 3) throw new Error('execution_run_host_action_stale');
            },
        });
        await expect(executor('reviews.comments.create', { ...input, body: 'substituted' }, { principal })).rejects.toMatchObject({ code: 'review_comment_permission_denied' });
        expect(axiosPostMock).not.toHaveBeenCalled();
        await expect(executor('reviews.comments.create', input, { principal })).rejects.toThrow('execution_run_host_action_stale');
        expect(axiosPostMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the complete private E2EE publication plan out of actual HTTP bytes', async () => {
        axiosPostMock.mockImplementationOnce(async (_url, body) => {
            // Axios is the genuine HTTP boundary; accept either shape so RED observes disclosure.
            const wire = body as {
                publicationPlanId?: string;
                entries: { happierCommentId: string; publicationCorrelationId?: string }[];
                verdict: { publicationCorrelationId?: string } | null;
            };
            return {
                status: 200,
                data: {
                    disposition: 'dispatch',
                    dispatchToken: 'dispatch-token-1',
                    publicationPlanId: wire.publicationPlanId ?? 'p'.repeat(43),
                    entries: wire.entries.map((entry) => ({
                        happierCommentId: entry.happierCommentId,
                        publicationCorrelationId: entry.publicationCorrelationId ?? 'a'.repeat(43),
                    })),
                    verdict: { publicationCorrelationId: wire.verdict?.publicationCorrelationId ?? 'v'.repeat(43) },
                    instructions: { entries: ['dispatch'], verdict: 'dispatch' },
                    priorResult: null,
                },
            };
        });
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) } },
            resolveAccountId: () => 'account-1',
            resolveAccountEncryptionMode: async () => 'e2ee',
        });
        await executor('reviews.comments.claimPublicationDispatch', {
            target: {
                providerId: 'github',
                configuredAccountId: 'private-connected-account',
                entryRef: { sourceId: 'github', kindId: 'pull-request', collisionScope: 'private-repository-id', entryId: 'private-pr-id' },
                subtarget: null,
            },
            baseRevision: 'private-base-sha',
            headRevision: 'private-head-sha',
            entries: [{
                happierCommentId: 'comment-1',
                expectedServerRevision: 1,
                anchor: { kind: 'line', filePath: 'private/source.ts', line: 4 },
                snapshot: {
                    kind: 'text', selectedLines: ['private selected code'], beforeContext: ['unpublished preceding code'],
                    afterContext: ['unpublished following code'], selectedLinesHash: 'selected', contextWindowHash: 'context',
                    capturedAt: 1, fileLength: 5, source: 'workingTree', isUncommitted: true, isUntracked: false,
                    truncated: false, hasBidiControls: false, likelyMinified: false,
                },
                body: 'private review body',
            }],
            verdict: { kind: 'comment', body: 'private verdict summary' },
        });
        const bytes = JSON.stringify(axiosPostMock.mock.calls[0]?.[1]);
        for (const privateText of [
            'private-connected-account', 'private-repository-id', 'private-pr-id', 'private-base-sha', 'private-head-sha',
            'private/source.ts', 'private selected code', 'unpublished preceding code', 'unpublished following code',
            'private review body', 'private verdict summary',
        ]) expect(bytes).not.toContain(privateText);
    });

    it('refuses a token-only E2EE publication before the HTTP boundary', async () => {
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: null },
            resolveAccountId: () => 'account-1',
            resolveAccountEncryptionMode: async () => 'e2ee',
        });
        await expect(executor('reviews.comments.claimPublicationDispatch', {
            target: {
                providerId: 'github', configuredAccountId: 'private-account',
                entryRef: { sourceId: 'github', kindId: 'pull-request', collisionScope: 'repo-1', entryId: '42' }, subtarget: null,
            },
            baseRevision: 'base-1', headRevision: 'head-1', entries: [],
            verdict: { kind: 'comment', body: 'Private summary' },
        })).rejects.toThrow('review_comment_encryption_material_unavailable');
        expect(axiosPostMock).not.toHaveBeenCalled();
    });

    it('signs host-derived agent review-comment principal headers with the machine installation identity', async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            ...plainEventStorageParams,
            credentials: {
                token: 'token-1',
                encryption: {
                    type: 'dataKey',
                    machineKey: new Uint8Array(32).fill(3),
                    publicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)).publicKey,
                },
            },
            resolvePrincipalSigningContext: async () => ({
                machineId: 'machine-1',
                installationId: 'installation-1',
                privateKeyBase64Url: Buffer.from(installationKeyPair.secretKey).toString('base64url'),
            }),
        });
        axiosPostMock.mockResolvedValueOnce({
            status: 200,
            data: {
                comment: {
                    v: 1,
                    id: 'comment-1',
                    accountId: 'account-1',
                    projectId: 'project-1',
                    anchor: { kind: 'file', filePath: 'src/a.ts' },
                    snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                    body: 'body',
                    bodyVersion: 1,
                    edits: [],
                    author: { kind: 'agent', agentId: 'claude', sessionId: 'session-1' },
                    state: 'proposed',
                    flags: {},
                    dispositions: {},
                    threadId: 'comment-1',
                    transitions: [{
                        transitionId: 'transition-1',
                        toState: 'proposed',
                        transitionedAt: 1,
                        transitionedBy: { kind: 'agent', agentId: 'claude', sessionId: 'session-1' },
                        serverRevision: 1,
                    }],
                    createdAt: 1,
                    updatedAt: 1,
                    serverRevision: 1,
                },
            },
        });

        const requestBody = {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        };
        const currentIntent = {
            v: 1 as const,
            kind: 'execution_run_host_action' as const,
            actionId: 'reviews.comments.create' as const,
            subjectFingerprint: 'a'.repeat(64),
            effectBodySha256Base64Url: createHash('sha256')
                .update(stringifyReviewCommentPrincipalCanonicalJsonV1(requestBody))
                .digest('base64url'),
            sessionId: 'session-1',
            runId: 'run-1',
            callId: 'call-1',
            profileId: 'acme.review/review',
            pluginId: 'acme.review',
            agentId: 'claude',
            projectId: 'project-1',
            workspaceId: 'workspace-1',
            sourceCustody: {
                kind: 'managed',
                immutableGenerationId: 'generation-1',
                installSource: 'archive',
            } as const,
        };

        await executor('reviews.comments.create', requestBody, {
            principal: {
                actor: { kind: 'agent', agentId: 'claude', sessionId: 'session-1' },
                currentIntent,
            },
        });

        const headers = axiosPostMock.mock.calls[0]?.[2]?.headers as Record<string, string> | undefined;
        const encoded = headers?.[REVIEW_COMMENT_PRINCIPAL_HEADER_V1];
        expect(encoded).toEqual(expect.any(String));
        const decoded = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')));
        expect(decoded.currentIntent).toEqual(currentIntent);
        expect(decoded.proof).toEqual(expect.objectContaining({
            v: 1,
            alg: 'ed25519-machine-installation-v1',
            machineId: 'machine-1',
            installationId: 'installation-1',
            method: 'POST',
            path: '/v1/reviews/comments',
            nonce: expect.any(String),
            signatureBase64Url: expect.any(String),
        }));
        const postedBody = axiosPostMock.mock.calls[0]?.[1];
        expect(decoded.proof!.bodySha256Base64Url).toBe(createHash('sha256')
            .update(stringifyReviewCommentPrincipalCanonicalJsonV1(postedBody))
            .digest('base64url'));
        expect(decoded.currentIntent?.effectBodySha256Base64Url).toBe(createHash('sha256')
            .update(stringifyReviewCommentPrincipalCanonicalJsonV1(requestBody))
            .digest('base64url'));

        const signature = Buffer.from(decoded.proof!.signatureBase64Url, 'base64url');
        expect(tweetnacl.sign.detached.verify(
            createReviewCommentPrincipalSigningInputV1({
                actor: decoded.actor,
                currentIntent: decoded.currentIntent,
                proof: {
                    v: decoded.proof!.v,
                    alg: decoded.proof!.alg,
                    machineId: decoded.proof!.machineId,
                    installationId: decoded.proof!.installationId,
                    issuedAt: decoded.proof!.issuedAt,
                    nonce: decoded.proof!.nonce,
                    method: decoded.proof!.method,
                    path: decoded.proof!.path,
                    bodySha256Base64Url: decoded.proof!.bodySha256Base64Url,
                },
            }),
            signature,
            installationKeyPair.publicKey,
        )).toBe(true);
    });

    it('revalidates the host-derived principal immediately before signing and sending the effect', async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
        const events: string[] = [];
        // This boundary must never run after asynchronous authority withdrawal.
        // Reset the prior encrypted-transport fixture as well as its call history.
        axiosPostMock.mockRejectedValue(new Error('effect_dispatched_without_current_authority'));
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            ...plainEventStorageParams,
            credentials: {
                token: 'token-1',
                encryption: { type: 'legacy', secret: new Uint8Array([1]) },
            },
            resolvePrincipalSigningContext: async () => {
                events.push('signing-context');
                return {
                    machineId: 'machine-1',
                    installationId: 'installation-1',
                    privateKeyBase64Url: Buffer.from(installationKeyPair.secretKey).toString('base64url'),
                };
            },
            assertPrincipalCurrent: () => {
                const currentness = Promise.resolve().then(() => {
                    events.push('currentness-check');
                    if (events.filter((event) => event === 'currentness-check').length === 2) {
                        throw new Error('execution_run_host_action_stale');
                    }
                });
                // The regression discards this promise; observe its rejection so
                // RED reports the dispatched effect rather than a harness error.
                void currentness.catch(() => {});
                return currentness;
            },
        });

        await expect(executor('reviews.comments.create', {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        }, {
            principal: {
                actor: { kind: 'agent', agentId: 'claude', sessionId: 'session-1' },
                currentIntent: {
                    v: 1,
                    kind: 'execution_run_host_action',
                    actionId: 'reviews.comments.create',
                    subjectFingerprint: 'a'.repeat(64),
                    effectBodySha256Base64Url: 'b'.repeat(43),
                    sessionId: 'session-1',
                    runId: 'run-1',
                    callId: 'call-1',
                    profileId: 'acme.review/review',
                    pluginId: 'acme.review',
                    agentId: 'claude',
                    projectId: 'project-1',
                    workspaceId: 'workspace-1',
                    sourceCustody: {
                        kind: 'managed',
                        immutableGenerationId: 'generation-1',
                        installSource: 'archive',
                    },
                },
            },
        })).rejects.toThrow('execution_run_host_action_stale');

        expect(events).toEqual(['signing-context', 'currentness-check', 'currentness-check']);
        expect(axiosPostMock).not.toHaveBeenCalled();
    });

    it('seals the verified user mutation binding into the single plain POST', async () => {
        axiosPostMock.mockResolvedValueOnce({
            status: 200,
            data: {
                comment: {
                    v: 1,
                    id: 'comment-1',
                    accountId: 'account-1',
                    projectId: 'project-1',
                    anchor: { kind: 'file', filePath: 'src/a.ts' },
                    snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                    body: 'body',
                    bodyVersion: 1,
                    edits: [],
                    author: { kind: 'user', userId: 'account-1' },
                    state: 'proposed',
                    flags: {},
                    dispositions: {},
                    threadId: 'comment-1',
                    transitions: [{
                        transitionId: 'transition-1',
                        toState: 'proposed',
                        transitionedAt: 1,
                        transitionedBy: { kind: 'user', userId: 'account-1' },
                        serverRevision: 1,
                    }],
                    createdAt: 1,
                    updatedAt: 1,
                    serverRevision: 1,
                },
            },
        });
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            ...plainEventStorageParams,
            credentials: { token: 'token-1', encryption: null },
        });

        await executor('reviews.comments.create', {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        });

        expect(axiosPostMock).toHaveBeenCalledTimes(1);
        const body = axiosPostMock.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(body.eventEnvelope).toEqual({
            t: 'plain',
            v: expect.objectContaining({
                v: 1,
                requestBinding: expect.objectContaining({
                    accountId: 'account-1',
                    projectId: 'project-1',
                    actionId: 'reviews.comments.create',
                    actor: { kind: 'user', userId: 'account-1' },
                    target: { kind: 'create' },
                    expectedCurrentness: { kind: 'create' },
                }),
            }),
        });
    });

    it('dispatches a plaintext-Account publication claim opaquely and without an event-envelope mutation', async () => {
        axiosPostMock.mockImplementationOnce(async (_url, body) => ({ status: 200, data: dispatchResponseFor(body) }));
        // The Account mode now decides the claim encoding, so it must be resolved before the POST.
        const resolveAccountEncryptionMode = vi.fn(async () => 'plain' as const);
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: null },
            resolveAccountId: () => 'account-1',
            resolveAccountEncryptionMode,
        });

        const claim = await executor('reviews.comments.claimPublicationDispatch', publicationPlan);

        expect(resolveAccountEncryptionMode.mock.calls).toEqual([
            [{ usage: 'identity' }], [{ usage: 'fresh-authority' }],
        ]);
        expect(axiosPostMock).toHaveBeenCalledTimes(1);
        expect(axiosPostMock.mock.calls[0]?.[0]).toMatch(/\/v1\/reviews\/comments\/publication\/claim$/);
        expect(axiosPostMock.mock.calls[0]?.[1]).not.toHaveProperty('eventEnvelope');
        expect(JSON.stringify(axiosPostMock.mock.calls[0]?.[1])).not.toContain('PRIVATE-');

        const wire = postedTransportRequest(0);
        expect(wire.mode).toBe('plain');
        expect(wire.contentPublicKeyFingerprint).toBeNull();
        expect(wire.targetKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(wire.entries).toEqual([{
            happierCommentId: 'comment-1',
            expectedServerRevision: 1,
            publicationCorrelationId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        }]);
        expect(claim).toEqual({
            disposition: 'dispatch',
            dispatchToken: 'dispatch-token-1',
            publicationPlanId: wire.publicationPlanId,
            entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: wire.entries[0]!.publicationCorrelationId }],
            verdict: { publicationCorrelationId: wire.verdict!.publicationCorrelationId },
            instructions: { entries: ['dispatch'], verdict: 'dispatch' },
            priorResult: null,
        });
    });

    it('settles an E2EE publication retry without putting provider references or failure text on the wire', async () => {
        axiosPostMock
            .mockImplementationOnce(async (_url, body) => ({ status: 200, data: dispatchResponseFor(body) }))
            .mockImplementationOnce(async (_url, body) => ({ status: 200, data: settlementResponseFor(body) }));
        const plan: ReviewCommentPublicationPlanV1 = {
            ...publicationPlan,
            entries: [
                publicationPlan.entries[0]!,
                { ...publicationPlan.entries[0]!, happierCommentId: 'comment-2', expectedServerRevision: 2 },
            ],
        };
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) } },
            resolveAccountId: () => 'account-1',
            resolveAccountEncryptionMode: async () => 'e2ee',
        });

        const claim = await executor(
            'reviews.comments.claimPublicationDispatch',
            plan,
        ) as ReviewCommentClaimPublicationDispatchResponseV1;
        const result = {
            publicationPlanId: claim.publicationPlanId,
            entries: [
                {
                    happierCommentId: 'comment-1',
                    publicationCorrelationId: claim.entries[0]!.publicationCorrelationId,
                    outcome: { kind: 'published' as const, externalRef: 'PRIVATE-native-comment-ref' },
                },
                {
                    happierCommentId: 'comment-2',
                    publicationCorrelationId: claim.entries[1]!.publicationCorrelationId,
                    outcome: {
                        kind: 'failed' as const,
                        code: 'PRIVATE-provider-code',
                        message: 'PRIVATE-provider-message',
                    },
                },
            ],
            verdict: {
                publicationCorrelationId: claim.verdict!.publicationCorrelationId,
                outcome: { kind: 'published' as const, externalRef: 'PRIVATE-native-verdict-ref' },
            },
        };

        const settled = await executor(
            'reviews.comments.claimPublicationDispatch',
            createReviewCommentPublicationSettlementRequestV1(plan, claim, result),
        ) as ReviewCommentClaimPublicationDispatchResponseV1;

        expect(axiosPostMock).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(axiosPostMock.mock.calls[1]?.[1])).not.toContain('PRIVATE-');
        const wire = postedTransportRequest(1);
        expect(wire.mode).toBe('e2ee');
        expect(wire.contentPublicKeyFingerprint).toEqual(expect.any(String));
        expect(wire.settlement?.dispatchToken).toBe('dispatch-token-1');
        const outcomes = [
            ...wire.settlement!.result.entries.map((entry) => entry.outcome),
            ...('kind' in wire.settlement!.result.verdict ? [] : [wire.settlement!.result.verdict.outcome]),
        ];
        expect(outcomes.map((outcome) => outcome.content?.t)).toEqual(['encrypted', 'encrypted', 'encrypted']);
        expect(new Set(outcomes.map((outcome) => outcome.content?.t === 'encrypted' ? outcome.content.c : '')).size)
            .toBe(outcomes.length);
        // The host reopens its own sealed prior outcomes when the server replays them.
        expect(settled.priorResult).toEqual(result);
    });

    it('refuses a publication response whose plan binding the server substituted', async () => {
        axiosPostMock.mockResolvedValueOnce({
            status: 200,
            data: {
                disposition: 'dispatch',
                dispatchToken: 'dispatch-token-1',
                publicationPlanId: 'p'.repeat(43),
                entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: 'a'.repeat(43) }],
                verdict: { publicationCorrelationId: 'v'.repeat(43) },
                instructions: { entries: ['dispatch'], verdict: 'dispatch' },
                priorResult: null,
            },
        });
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: null },
            resolveAccountId: () => 'account-1',
            resolveAccountEncryptionMode: async () => 'plain',
        });

        await expect(executor('reviews.comments.claimPublicationDispatch', publicationPlan))
            .rejects.toThrow('review_comment_publication_binding_mismatch');
        expect(axiosPostMock).toHaveBeenCalledTimes(1);
    });

    it('fails token-only E2EE before the mutation POST', async () => {
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: null },
            resolveAccountId: () => 'account-1',
            resolveAccountEncryptionMode: async () => 'e2ee',
        });

        await expect(executor('reviews.comments.create', {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        })).rejects.toThrow('review_comment_encryption_material_unavailable');
        expect(axiosPostMock).not.toHaveBeenCalled();
    });
});
