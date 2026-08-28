import { createHash } from 'node:crypto';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { createCliReviewCommentActionExecutorFromCredentials } from './executor';
import {
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    ReviewCommentPrincipalHeaderV1Schema,
    createReviewCommentPrincipalSigningInputV1,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
} from '@happier-dev/protocol';

const axiosPostMock = vi.mocked(axios.post);

const plainEventStorageParams = {
    resolveAccountId: () => 'account-1',
    resolveAccountEncryptionMode: async () => 'plain' as const,
};

vi.mock('axios', () => ({
    default: {
        post: vi.fn(),
        get: vi.fn(),
        patch: vi.fn(),
    },
}));

describe('createCliReviewCommentActionExecutorFromCredentials', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
            immutableGenerationId: 'generation-1',
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
                events.push('currentness-check');
                if (events.filter((event) => event === 'currentness-check').length === 2) {
                    throw new Error('execution_run_host_action_stale');
                }
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
                    immutableGenerationId: 'generation-1',
                },
            },
        })).rejects.toThrow('execution_run_host_action_stale');

        expect(events).toEqual(['signing-context', 'currentness-check', 'currentness-check']);
        expect(axiosPostMock).not.toHaveBeenCalled();
    });

    it('preserves direct-write denial without publishing a legacy plugin grant request', async () => {
        axiosPostMock.mockResolvedValueOnce({
            status: 400,
            data: {
                error: 'review_comment_direct_write_permission_required',
                message: 'reviews.comments.write.direct is required',
            },
        });
        const signingKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            ...plainEventStorageParams,
            credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            resolvePrincipalSigningContext: async () => ({
                machineId: 'machine-1',
                installationId: 'installation-1',
                privateKeyBase64Url: Buffer.from(signingKeyPair.secretKey).toString('base64url'),
            }),
        });

        await expect(executor('reviews.comments.create', {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'Fix this directly.',
            authorIntent: 'open',
            clientMutationId: 'mutation-1',
        }, {
            principal: {
                actor: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
            },
        })).rejects.toMatchObject({ code: 'review_comment_direct_write_permission_required' });

        expect(axiosPostMock).toHaveBeenCalledTimes(1);
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

    it('dispatches publication claims without attempting an event-envelope mutation', async () => {
        axiosPostMock.mockResolvedValueOnce({
            status: 200,
            data: {
                disposition: 'dispatch',
                publicationPlanId: 'p'.repeat(43),
                entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: 'a'.repeat(43) }],
                verdict: { publicationCorrelationId: 'v'.repeat(43) },
            },
        });
        const resolveAccountEncryptionMode = vi.fn(async () => 'plain' as const);
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: null },
            resolveAccountEncryptionMode,
        });
        const target = {
            providerId: 'github',
            configuredAccountId: 'github-account-1',
            entryRef: {
                sourceId: 'github',
                kindId: 'pull-request',
                collisionScope: 'github:repository-1',
                entryId: '42',
            },
            subtarget: null,
        };

        const publicationPlan = {
            target,
            baseRevision: 'base-1',
            headRevision: 'head-1',
            entries: [{
                happierCommentId: 'comment-1',
                expectedServerRevision: 1,
                anchor: { kind: 'file' as const, filePath: 'src/a.ts' },
                snapshot: { kind: 'too_large' as const, filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                body: 'body',
            }],
            verdict: { kind: 'comment' as const, body: 'Summary' },
        };
        await expect(executor('reviews.comments.claimPublicationDispatch', publicationPlan)).resolves.toEqual({
            disposition: 'dispatch',
            publicationPlanId: 'p'.repeat(43),
            entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: 'a'.repeat(43) }],
            verdict: { publicationCorrelationId: 'v'.repeat(43) },
        });

        expect(resolveAccountEncryptionMode).not.toHaveBeenCalled();
        expect(axiosPostMock).toHaveBeenCalledWith(
            expect.stringMatching(/\/v1\/reviews\/comments\/publication\/claim$/),
            publicationPlan,
            expect.any(Object),
        );
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
