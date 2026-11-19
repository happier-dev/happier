import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { computeCanonicalDomainSeparatedKeyedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';

import {
    ReviewCommentPublicationTransportRequestV1Schema,
    type ReviewCommentPublicationTransportRequestV1} from '@happier-dev/protocol/reviews/comments/publicationTransport';
import {
    ReviewCommentPrepareMutationRequestV1Schema,
    ReviewCommentPrepareMutationResponseV1Schema,
    ReviewCommentCommitMutationRequestV1Schema,
    deriveReviewCommentStructuralMutationV1,
    type ReviewCommentPrepareMutationResponseV1,
} from '@happier-dev/protocol/reviews/comments/mutation';
import {
    ReviewCommentActionOutputSchemasV1,
    createReviewCommentPublicationSettlementRequestV1,
    type ReviewCommentClaimPublicationDispatchResponseV1,
    type ReviewCommentPublicationPlanV1} from '@happier-dev/protocol/reviews/comments/actions';
import {
    openStoredReviewCommentV1,
    sealReviewCommentSensitiveEnvelopeV1,
    splitReviewCommentV1,
    type StoredReviewCommentV1} from '@happier-dev/protocol/reviews/comments/content';
import {
    type AccountScopedCryptoMaterial} from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    type ReviewCommentV1} from '@happier-dev/protocol/reviews/comments/v1';

const serverFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

/**
 * Every private plan string carries `PRIVATE-`, so one substring sweep over the
 * bytes `serverFetch` actually received covers present and future request
 * fields. `happierCommentId` is excluded: the Happier server owns that row.
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

const e2eeMaterial: AccountScopedCryptoMaterial = { type: 'legacy', secret: new Uint8Array(32).fill(5) };

/** Distinct bytes per call so every seal gets its own nonce. */
function countingRandomBytes(): (length: number) => Uint8Array {
    let counter = 0;
    return (length) => {
        counter += 1;
        const bytes = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) bytes[index] = (counter * 17 + index * 7) % 256;
        return bytes;
    };
}

const fixtureRandomBytes = countingRandomBytes();

function postedTransportRequest(callIndex: number): ReviewCommentPublicationTransportRequestV1 {
    const init = serverFetchSpy.mock.calls[callIndex]?.[1] as RequestInit | undefined;
    return ReviewCommentPublicationTransportRequestV1Schema.parse(JSON.parse(String(init?.body)));
}

function publicationResponseFor(body: unknown, settled: boolean): unknown {
    const request = ReviewCommentPublicationTransportRequestV1Schema.parse(JSON.parse(String(body)));
    return {
        disposition: settled ? 'reconcile' : 'dispatch',
        dispatchToken: settled ? null : 'dispatch-token-1',
        publicationPlanId: request.publicationPlanId,
        entries: request.entries.map(({ happierCommentId, publicationCorrelationId }) => ({
            happierCommentId,
            publicationCorrelationId,
        })),
        verdict: request.verdict,
        instructions: {
            entries: request.entries.map(() => settled ? 'confirmed' : 'dispatch'),
            verdict: request.verdict === null ? null : settled ? 'confirmed' : 'dispatch',
        },
        priorResult: request.settlement?.result ?? null,
    };
}

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        workspaceId: overrides.workspaceId,
        runId: overrides.runId,
        engineId: overrides.engineId,
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'body',
        bodyVersion: 1,
        edits: [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state: overrides.state ?? 'open',
        flags: overrides.flags ?? {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: overrides.updatedAt ?? 1,
        serverRevision: overrides.serverRevision ?? 1,
        ...overrides,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function storedComment(value: ReviewCommentV1, mode: 'plain' | 'e2ee' = 'e2ee'): StoredReviewCommentV1 {
    const split = splitReviewCommentV1(value);
    return {
        v: 1,
        structural: split.structural,
        sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({
            ...split,
            ...(mode === 'plain'
                ? { mode: 'plain' as const }
                : { mode: 'e2ee' as const, material: e2eeMaterial, randomBytes: fixtureRandomBytes }),
        }),
    };
}

function installEncryptedMutationHttpBoundary() {
    const stored = new Map<string, StoredReviewCommentV1>();
    let preparation: ReviewCommentPrepareMutationResponseV1 | undefined;
    let idCounter = 0;
    let now = 1;
    // HTTP responses are the external boundary; structural derivation and client crypto stay real.
    serverFetchSpy.mockImplementation(async (path: string, init: RequestInit) => {
        if (path.endsWith('/mutations/prepare')) {
            const request = ReviewCommentPrepareMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
            const derived = deriveReviewCommentStructuralMutationV1({
                mutation: request.mutation,
                accountId: 'account-1',
                actor: { kind: 'user', userId: 'account-1' },
                current: [...stored.values()].map((value) => value.structural),
                runtime: { now: () => ++now, createId: (prefix) => `${prefix}-${++idCounter}` },
            });
            preparation = ReviewCommentPrepareMutationResponseV1Schema.parse({
                v: 1, request, receipt: `receipt-${idCounter}`, replayed: false, ...derived,
                records: derived.records.map((record) => {
                    const prior = stored.get(request.mutation.actionId === 'reviews.comments.reply'
                        ? request.mutation.input.parentCommentId : record.structural.id);
                    return { ...record, ...(prior ? { previous: {
                        structural: prior.structural,
                        source: { v: 1, layout: 'canonical_v1', envelope: prior.sensitiveEnvelope },
                    } } : {}) };
                }),
            });
            return jsonResponse(preparation);
        }
        if (path.endsWith('/mutations/commit')) {
            const request = ReviewCommentCommitMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
            if (!preparation || request.receipt !== preparation.receipt) throw new Error('Unexpected preparation receipt');
            const prepared = preparation;
            const comments = request.records.map((record): StoredReviewCommentV1 => {
                const structural = prepared.records.find((value) => value.structural.id === record.commentId)?.structural;
                if (!structural) throw new Error('Missing prepared structural record');
                const value = { v: 1 as const, structural, sensitiveEnvelope: record.sensitiveEnvelope };
                stored.set(record.commentId, value);
                return value;
            });
            return jsonResponse({ v: 1, comments, replayed: false, failed: prepared.failed,
                ...(prepared.bulkActionId ? { bulkActionId: prepared.bulkActionId } : {}) });
        }
        throw new Error(`Unexpected HTTP path ${path}`);
    });
    return {
        open(id: string): ReviewCommentV1 {
            const record = stored.get(id);
            if (!record) throw new Error('Missing stored comment');
            const result = openStoredReviewCommentV1({ stored: record, mode: 'e2ee', material: e2eeMaterial });
            if (result.status !== 'available') throw new Error(`Stored comment is ${result.reason}`);
            return result.comment;
        },
        ids: () => [...stored.keys()],
    };
}

describe('review comments HTTP action executor', () => {
    beforeEach(() => {
        serverFetchSpy.mockReset();
    });

    it.each([true, false])('opens another author’s Review-key content without an Account key (explicit Review scope: %s)', async scoped => {
        const dataKey = new Uint8Array(32).fill(31);
        const codec = new ArtifactEncryption(dataKey);
        const durable = comment({ reviewId: 'review-resource', accountId: 'another-author', body: 'PRIVATE-shared-comment' });
        const stored = storedComment(durable, 'plain');
        if (stored.sensitiveEnvelope.t !== 'plain') throw new Error('Expected logical payload');
        stored.sensitiveEnvelope = { t: 'encrypted', c: await codec.encryptHeader(stored.sensitiveEnvelope.v as Record<string, unknown>) };
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ comment: stored }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => { throw new Error('A recipient Account key is unavailable'); },
            resolveReviewResourceContext: async reviewId => ({ accountId: 'recipient', resource: {
                reviewId, mode: 'e2ee',
                open: async content => content.t === 'encrypted' ? codec.decryptHeaderRaw(content.c) : null,
                seal: async value => ({ t: 'encrypted', c: await codec.encryptHeader(value as Record<string, unknown>) }),
                commitment: (purpose, value) => computeCanonicalDomainSeparatedKeyedDigest(dataKey, 'review-test', [reviewId, purpose, value]),
            } }),
        });
        await expect(execute('reviews.comments.get', { commentId: durable.id, ...(scoped ? { reviewId: durable.reviewId } : {}) }))
            .resolves.toEqual({ comment: durable });
        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(stored)).not.toContain(durable.body);
    });

    it('executes list actions through the authenticated review comments API', async () => {
        const durableComment = comment({
            body: 'Loaded through HTTP.', sessionId: 'session-1',
            anchor: { kind: 'file', filePath: 'src/security/a.ts' },
            metadata: { severity: 'critical', taxonomyIds: ['security.open_redirect', 'cwe.601'] },
        });
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ items: [storedComment(durableComment, 'plain')], cursor: null }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'plain' }),
        });
        await expect(execute('reviews.comments.list', {
            projectId: 'project-1',
            sessionId: 'session-1',
            states: ['open'],
            folderPath: 'src/security',
            severity: 'critical',
            taxonomyIds: ['security.open_redirect', 'cwe.601'],
            includeHistory: true,
            limit: 10,
        })).resolves.toEqual({ items: [durableComment], cursor: null });

        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
        const [path, init, options] = serverFetchSpy.mock.calls[0] ?? [];
        expect(String(path)).toContain('/v1/reviews/comments?');
        expect(String(path)).toContain('projectId=project-1');
        expect(String(path)).toContain('sessionId=session-1');
        expect(String(path)).toContain('states=open');
        expect(String(path)).not.toContain('folderPath=');
        expect(String(path)).not.toContain('severity=');
        expect(String(path)).not.toContain('taxonomyIds=');
        expect(String(path)).toContain('stored=true');
        expect(String(path)).toContain('includeHistory=true');
        expect(String(path)).toContain('limit=10');
        expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
        expect(options).toEqual(expect.objectContaining({ includeAuth: true }));
    });

    it('opens stored E2EE comments for get and list without returning ciphertext to consumers', async () => {
        const durableComment = comment({ body: 'PRIVATE-opened-body', snapshot: publicationPlan.entries[0]!.snapshot });
        const stored = storedComment(durableComment);
        serverFetchSpy
            .mockResolvedValueOnce(jsonResponse({ comment: stored }))
            .mockResolvedValueOnce(jsonResponse({ items: [stored], cursor: null }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'e2ee', material: e2eeMaterial }),
        });

        await expect(execute('reviews.comments.get', { commentId: 'comment-1', includeHistory: true }))
            .resolves.toEqual({ comment: durableComment });
        await expect(execute('reviews.comments.list', { projectId: 'project-1', includeHistory: true }))
            .resolves.toEqual({ items: [durableComment], cursor: null });
        expect(JSON.stringify(stored)).not.toContain('PRIVATE-opened-body');
        for (const [, , options] of serverFetchSpy.mock.calls) {
            expect(options).toEqual({ includeAuth: true });
        }
    });

    it('refuses stored comments when Account mode, key, or structural binding is inconsistent', async () => {
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const durableComment = comment({ body: 'PRIVATE-locked-body' });
        const encrypted = storedComment(durableComment);
        if (encrypted.sensitiveEnvelope.t !== 'encrypted') throw new Error('Expected encrypted fixture');
        const ciphertext = encrypted.sensitiveEnvelope.c;
        const tamperIndex = Math.floor(ciphertext.length / 2);
        const tampered = { ...encrypted, sensitiveEnvelope: { t: 'encrypted' as const,
            c: `${ciphertext.slice(0, tamperIndex)}${ciphertext[tamperIndex] === 'A' ? 'B' : 'A'}${ciphertext.slice(tamperIndex + 1)}` } };
        const wrongKey: AccountScopedCryptoMaterial = { type: 'legacy', secret: new Uint8Array(32).fill(8) };
        const cases = [
            { stored: encrypted, code: 'review_comment_encryption_material_unavailable', context: { accountId: 'account-1', mode: 'e2ee' as const } },
            { stored: storedComment(durableComment, 'plain'), code: 'review_comment_encryption_mode_mismatch', context: { accountId: 'account-1', mode: 'e2ee' as const, material: e2eeMaterial } },
            { stored: encrypted, code: 'review_comment_encryption_mode_mismatch', context: { accountId: 'account-1', mode: 'plain' as const } },
            { stored: encrypted, code: 'review_comment_content_unreadable', context: { accountId: 'account-1', mode: 'e2ee' as const, material: wrongKey } },
            { stored: tampered, code: 'review_comment_content_unreadable', context: { accountId: 'account-1', mode: 'e2ee' as const, material: e2eeMaterial } },
            { stored: { ...encrypted, structural: { ...encrypted.structural, serverRevision: 2 } }, code: 'review_comment_content_binding_mismatch', context: { accountId: 'account-1', mode: 'e2ee' as const, material: e2eeMaterial } },
        ];
        for (const testCase of cases) {
            serverFetchSpy.mockReset();
            serverFetchSpy.mockResolvedValueOnce(jsonResponse({ comment: testCase.stored }));
            const execute = createReviewCommentsHttpActionExecutor({ resolveEventStorageContext: async () => testCase.context });
            await expect(execute('reviews.comments.get', { commentId: 'comment-1', includeHistory: true }))
                .rejects.toMatchObject({ code: testCase.code });
        }
    });

    it('filters one demanded E2EE page and continues explicitly without disclosing a private path', async () => {
        const skipped = comment({ id: 'comment-skipped', anchor: { kind: 'file', filePath: 'src/other.ts' } });
        const matched = comment({ id: 'comment-matched', anchor: { kind: 'file', filePath: 'PRIVATE-source/file.ts' } });
        serverFetchSpy
            .mockResolvedValueOnce(jsonResponse({ items: [storedComment(skipped)], cursor: 'next-page' }))
            .mockResolvedValueOnce(jsonResponse({ items: [storedComment(matched)], cursor: null }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'e2ee', material: e2eeMaterial }),
        });

        const first = await execute('reviews.comments.list', {
            projectId: 'project-1', filePath: 'PRIVATE-source/file.ts', includeHistory: true, limit: 1,
        });
        expect(first).toEqual({ items: [], cursor: expect.any(String) });
        const { cursor } = ReviewCommentActionOutputSchemasV1['reviews.comments.list'].parse(first);
        if (!cursor) throw new Error('Expected explicit continuation');
        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
        await expect(execute('reviews.comments.list', {
            projectId: 'project-1', filePath: 'PRIVATE-source/file.ts', includeHistory: true, limit: 1, cursor,
        })).resolves.toEqual({ items: [matched], cursor: null });
        expect(serverFetchSpy.mock.calls.map(([path]) => String(path)).join('\n')).not.toContain('PRIVATE-');
        expect(String(serverFetchSpy.mock.calls[1]?.[0])).toContain('cursor=next-page');
    });

    it('seals a plain transition event with request-known binding in the single mutation POST', async () => {
        const durableComment = comment({ state: 'resolved' });
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ comment: durableComment }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({
                accountId: 'account-1',
                mode: 'plain',
            }),
        });
        await expect(execute('reviews.comments.transition', {
            projectId: 'project-1',
            commentId: 'comment-1',
            expectedState: 'open',
            expectedServerRevision: 1,
            toState: 'resolved',
            reason: 'Verified',
            clientMutationId: 'mutation-1',
        })).resolves.toEqual({ comment: durableComment });

        const [path, init] = serverFetchSpy.mock.calls[0] ?? [];
        expect(path).toBe('/v1/reviews/comments/comment-1/transition');
        expect(init).toEqual(expect.objectContaining({ method: 'POST' }));
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
                projectId: 'project-1',
                expectedState: 'open',
                expectedServerRevision: 1,
                toState: 'resolved',
                reason: 'Verified',
                clientMutationId: 'mutation-1',
                eventEnvelope: {
                    t: 'plain',
                    v: {
                        v: 1,
                        requestBinding: expect.objectContaining({
                            accountId: 'account-1',
                            projectId: 'project-1',
                            actionId: 'reviews.comments.transition',
                            eventKind: 'transitioned',
                            actor: { kind: 'user', userId: 'account-1' },
                            target: { kind: 'comment', commentId: 'comment-1' },
                            expectedCurrentness: {
                                kind: 'transition',
                                expectedState: 'open',
                                expectedServerRevision: 1,
                            },
                        }),
                        details: expect.objectContaining({
                            commentId: 'comment-1',
                            reason: 'Verified',
                        }),
                    },
                },
            });
        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails a token-only E2EE mutation before POST', async () => {
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({
                accountId: 'account-1',
                mode: 'e2ee',
            }),
        });

        await expect(execute('reviews.comments.create', {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        })).rejects.toThrow('review_comment_encryption_material_unavailable');
        expect(serverFetchSpy).not.toHaveBeenCalled();
    });

    it('executes encrypted CRUD through prepared records while keeping sensitive request fields opaque', async () => {
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const boundary = installEncryptedMutationHttpBoundary();
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'e2ee', material: e2eeMaterial }),
            randomBytes: countingRandomBytes(),
        });
        const controller = new AbortController();
        await expect(execute('reviews.comments.create', {
            projectId: 'project-1',
            anchor: publicationPlan.entries[0]!.anchor,
            snapshot: publicationPlan.entries[0]!.snapshot,
            body: publicationPlan.entries[0]!.body,
            evidence: [{ kind: 'reasoning', message: 'PRIVATE-evidence' }],
            authorIntent: 'open',
            clientMutationId: 'mutation-1',
        }, { signal: controller.signal })).resolves.toMatchObject({ comment: { body: 'PRIVATE-review-body', state: 'open' }, replayed: false });
        expect(serverFetchSpy.mock.calls.slice(0, 2).map(([, init]) => (init as RequestInit).signal))
            .toEqual([controller.signal, controller.signal]);
        const id = boundary.ids()[0]!;
        await expect(execute('reviews.comments.setDisposition', {
            projectId: 'project-1', commentId: id, expectedServerRevision: 1,
            disposition: 'blocking', clientMutationId: 'mutation-2',
        })).resolves.toMatchObject({ comment: { body: 'PRIVATE-review-body', serverRevision: 2,
            dispositions: { 'user:account-1': 'blocking' } } });
        await expect(execute('reviews.comments.edit', {
            projectId: 'project-1', commentId: id, expectedServerRevision: 2, expectedBodyVersion: 1,
            nextBody: 'PRIVATE-edited-body', reason: 'PRIVATE-edit-reason', clientMutationId: 'mutation-3',
        })).resolves.toMatchObject({ comment: { body: 'PRIVATE-edited-body', bodyVersion: 2, serverRevision: 3 } });
        await expect(execute('reviews.comments.attachEvidence', {
            projectId: 'project-1', commentId: id, expectedServerRevision: 3,
            evidence: [{ kind: 'reasoning', message: 'PRIVATE-attached-evidence' }], clientMutationId: 'mutation-4',
        })).resolves.toMatchObject({ comment: { serverRevision: 4, evidence: [
            { kind: 'reasoning', message: 'PRIVATE-evidence' },
            { kind: 'reasoning', message: 'PRIVATE-attached-evidence' },
        ] } });
        await expect(execute('reviews.comments.reply', {
            projectId: 'project-1', parentCommentId: id, expectedParentServerRevision: 4,
            body: 'PRIVATE-reply', clientMutationId: 'mutation-5',
        })).resolves.toMatchObject({ comment: { body: 'PRIVATE-reply', parentCommentId: id }, parent: { id, serverRevision: 4 } });
        await expect(execute('reviews.comments.bulkTransition', {
            projectId: 'project-1', commentIds: [id, 'missing-comment'], expectedServerRevisions: { [id]: 4, 'missing-comment': 1 },
            expectedState: 'open', toState: 'pending_review', reason: 'PRIVATE-bulk-reason', clientMutationId: 'mutation-6',
        })).resolves.toMatchObject({ updated: [{ id, state: 'pending_review', serverRevision: 5 }],
            failed: [{ commentId: 'missing-comment', errorCode: 'review_comment_not_found' }] });
        await expect(execute('reviews.comments.transition', {
            projectId: 'project-1', commentId: id, expectedServerRevision: 5, expectedState: 'pending_review',
            toState: 'resolved', reason: 'PRIVATE-transition-reason', clientMutationId: 'mutation-7',
        })).resolves.toMatchObject({ comment: { state: 'resolved', serverRevision: 6 } });
        await expect(execute('reviews.comments.redact', {
            projectId: 'project-1', commentId: id, expectedServerRevision: 6,
            reason: 'PRIVATE-redaction-reason', clientMutationId: 'mutation-8',
        })).resolves.toMatchObject({ comment: { body: '', edits: [], serverRevision: 7, flags: { redacted: true } } });
        expect(boundary.open(id).transitions.at(-1)?.reason).toBe('PRIVATE-transition-reason');
        const wire = serverFetchSpy.mock.calls.map(([path, init]) => `${path}\n${String((init as RequestInit).body)}`).join('\n');
        expect(wire).not.toContain('PRIVATE-');
        for (const [, init, options] of serverFetchSpy.mock.calls) {
            expect(init).toEqual(expect.objectContaining({ method: 'POST' }));
            expect(options).toEqual({ includeAuth: true });
        }
    });

    it('preserves the server error code when encrypted preparation is refused', async () => {
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'review_comment_conflict', message: 'Current revision changed' }, 409));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'e2ee', material: e2eeMaterial }),
            randomBytes: countingRandomBytes(),
        });
        await expect(execute('reviews.comments.setDisposition', {
            projectId: 'project-1', commentId: 'comment-1', expectedServerRevision: 1,
            disposition: 'blocking', clientMutationId: 'mutation-stale',
        })).rejects.toMatchObject({ code: 'review_comment_conflict' });
        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
        expect(serverFetchSpy.mock.calls[0]?.[0]).toBe('/v1/reviews/comments/mutations/prepare');
    });

    it('claims one plaintext-Account publication dispatch opaquely and without a comment mutation event', async () => {
        serverFetchSpy.mockImplementationOnce(async (_path: string, init: RequestInit) =>
            jsonResponse(publicationResponseFor(init.body, false)));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'plain' }),
            randomBytes: countingRandomBytes(),
        });
        const claim = await execute('reviews.comments.claimPublicationDispatch', publicationPlan);

        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
        const [path, init, options] = serverFetchSpy.mock.calls[0] ?? [];
        expect(path).toBe('/v1/reviews/comments/publication/claim');
        expect(init).toEqual(expect.objectContaining({ method: 'POST' }));
        expect(options).toEqual({ includeAuth: true });
        expect(String((init as RequestInit).body)).not.toContain('PRIVATE-');
        expect(String((init as RequestInit).body)).not.toContain('eventEnvelope');

        const wire = postedTransportRequest(0);
        expect(wire.mode).toBe('plain');
        expect(wire.contentPublicKeyFingerprint).toBeNull();
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

    it('settles an E2EE publication without putting provider references or failure text on the wire', async () => {
        serverFetchSpy
            .mockImplementationOnce(async (_path: string, init: RequestInit) =>
                jsonResponse(publicationResponseFor(init.body, false)))
            .mockImplementationOnce(async (_path: string, init: RequestInit) =>
                jsonResponse(publicationResponseFor(init.body, true)));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const plan: ReviewCommentPublicationPlanV1 = {
            ...publicationPlan,
            entries: [
                publicationPlan.entries[0]!,
                { ...publicationPlan.entries[0]!, happierCommentId: 'comment-2', expectedServerRevision: 2 },
            ],
        };
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'e2ee', material: e2eeMaterial }),
            randomBytes: countingRandomBytes(),
        });

        const claim = await execute(
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

        const settled = await execute(
            'reviews.comments.claimPublicationDispatch',
            createReviewCommentPublicationSettlementRequestV1(plan, claim, result),
        ) as ReviewCommentClaimPublicationDispatchResponseV1;

        expect(serverFetchSpy).toHaveBeenCalledTimes(2);
        const settlementBody = String((serverFetchSpy.mock.calls[1]?.[1] as RequestInit).body);
        expect(settlementBody).not.toContain('PRIVATE-');
        const wire = postedTransportRequest(1);
        expect(wire.mode).toBe('e2ee');
        expect(wire.contentPublicKeyFingerprint).toEqual(expect.any(String));
        const outcomes = [
            ...wire.settlement!.result.entries.map((entry) => entry.outcome),
            ...('kind' in wire.settlement!.result.verdict ? [] : [wire.settlement!.result.verdict.outcome]),
        ];
        expect(outcomes.map((outcome) => outcome.content?.t)).toEqual(['encrypted', 'encrypted', 'encrypted']);
        expect(settled.priorResult).toEqual(result);
    });

    it('fails a token-only E2EE publication claim before POST', async () => {
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'e2ee' }),
        });

        await expect(execute('reviews.comments.claimPublicationDispatch', publicationPlan))
            .rejects.toThrow('review_comment_encryption_material_unavailable');
        expect(serverFetchSpy).not.toHaveBeenCalled();
    });

    it('refuses a publication response whose plan binding the server substituted', async () => {
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({
            disposition: 'dispatch',
            dispatchToken: 'dispatch-token-1',
            publicationPlanId: 'P'.repeat(43),
            entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: 'A'.repeat(43) }],
            verdict: { publicationCorrelationId: 'V'.repeat(43) },
            instructions: { entries: ['dispatch'], verdict: 'dispatch' },
            priorResult: null,
        }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({ accountId: 'account-1', mode: 'plain' }),
        });

        await expect(execute('reviews.comments.claimPublicationDispatch', publicationPlan))
            .rejects.toThrow('review_comment_publication_binding_mismatch');
        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
    });
});
