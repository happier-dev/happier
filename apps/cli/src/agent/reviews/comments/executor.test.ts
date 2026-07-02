import { createHash } from 'node:crypto';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { createCliReviewCommentActionExecutorFromCredentials } from './executor';
import {
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    PluginInstallationManifestPublisherHeaderV1Schema,
    ReviewCommentPrincipalHeaderV1Schema,
    createPluginInstallationManifestPublisherSigningInputV1,
    createReviewCommentPrincipalSigningInputV1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
} from '@happier-dev/protocol';

const axiosPostMock = vi.mocked(axios.post);

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

    it('signs plugin review-comment principal headers with the machine installation identity', async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const executor = createCliReviewCommentActionExecutorFromCredentials({
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
                    author: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
                    state: 'proposed',
                    flags: {},
                    dispositions: {},
                    threadId: 'comment-1',
                    transitions: [{
                        transitionId: 'transition-1',
                        toState: 'proposed',
                        transitionedAt: 1,
                        transitionedBy: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
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

        await executor('reviews.comments.create', requestBody, {
            principal: {
                actor: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
                grants: ['reviews.comments.write.direct'],
            },
        });

        const headers = axiosPostMock.mock.calls[0]?.[2]?.headers as Record<string, string> | undefined;
        const encoded = headers?.[REVIEW_COMMENT_PRINCIPAL_HEADER_V1];
        expect(encoded).toEqual(expect.any(String));
        const decoded = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')));
        expect(decoded.grants).toEqual([]);
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
        expect(decoded.proof!.bodySha256Base64Url).toBe(createHash('sha256')
            .update(stringifyReviewCommentPrincipalCanonicalJsonV1(requestBody))
            .digest('base64url'));

        const signature = Buffer.from(decoded.proof!.signatureBase64Url, 'base64url');
        expect(tweetnacl.sign.detached.verify(
            createReviewCommentPrincipalSigningInputV1({
                actor: decoded.actor,
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

    it('publishes a generic pending grant request when plugin direct review-comment write is denied', async () => {
        axiosPostMock
            .mockResolvedValueOnce({
                status: 400,
                data: {
                    error: 'review_comment_direct_write_permission_required',
                    message: 'reviews.comments.write.direct is required',
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    pendingRequest: {
                        v: 1,
                        id: 'request-1',
                        accountId: 'account-1',
                        pluginId: 'happier.review.coderabbit',
                        capability: 'reviews.comments.write.direct',
                        targetScope: { kind: 'project', projectId: 'project-1' },
                        authoritySource: {
                            kind: 'machine_installation',
                            machineId: 'machine-1',
                            installationId: 'installation-1',
                        },
                        requester: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
                        reason: 'Plugin requested direct review-comment write access.',
                        status: 'pending',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                },
            });
        const grantRequestKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const executor = createCliReviewCommentActionExecutorFromCredentials({
            credentials: { token: 'token-1', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
            resolvePrincipalSigningContext: async () => ({
                machineId: 'machine-1',
                installationId: 'installation-1',
                privateKeyBase64Url: Buffer.from(grantRequestKeyPair.secretKey).toString('base64url'),
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
                grants: [],
            },
        })).rejects.toMatchObject({ code: 'review_comment_direct_write_permission_required' });

        expect(axiosPostMock).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('/v1/plugins/permissions/grants/request'),
            {
                pluginId: 'happier.review.coderabbit',
                capability: 'reviews.comments.write.direct',
                targetScope: { kind: 'project', projectId: 'project-1' },
                requester: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
                reason: 'Plugin requested direct review-comment write access.',
            },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-1',
                }),
            }),
        );
        const grantHeaders = axiosPostMock.mock.calls[1]?.[2]?.headers as Record<string, string> | undefined;
        const publisherHeader = grantHeaders?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1];
        expect(publisherHeader).toEqual(expect.any(String));
        const decoded = PluginInstallationManifestPublisherHeaderV1Schema.parse(
            JSON.parse(Buffer.from(publisherHeader!, 'base64url').toString('utf8')),
        );
        expect(decoded.proof).toEqual(expect.objectContaining({
            v: 1,
            alg: 'ed25519-machine-installation-v1',
            machineId: 'machine-1',
            installationId: 'installation-1',
            method: 'POST',
            path: '/v1/plugins/permissions/grants/request',
            nonce: expect.any(String),
            signatureBase64Url: expect.any(String),
        }));
        const requestBody = {
            pluginId: 'happier.review.coderabbit',
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'project', projectId: 'project-1' },
            requester: { kind: 'plugin', pluginId: 'happier.review.coderabbit' },
            reason: 'Plugin requested direct review-comment write access.',
        };
        expect(decoded.proof.bodySha256Base64Url).toBe(createHash('sha256')
            .update(stringifyPluginInstallationManifestCanonicalJsonV1(requestBody))
            .digest('base64url'));
        expect(tweetnacl.sign.detached.verify(
            createPluginInstallationManifestPublisherSigningInputV1({
                proof: {
                    v: decoded.proof.v,
                    alg: decoded.proof.alg,
                    machineId: decoded.proof.machineId,
                    installationId: decoded.proof.installationId,
                    issuedAt: decoded.proof.issuedAt,
                    nonce: decoded.proof.nonce,
                    method: decoded.proof.method,
                    path: decoded.proof.path,
                    bodySha256Base64Url: decoded.proof.bodySha256Base64Url,
                },
            }),
            Buffer.from(decoded.proof.signatureBase64Url, 'base64url'),
            grantRequestKeyPair.publicKey,
        )).toBe(true);
    });
});
