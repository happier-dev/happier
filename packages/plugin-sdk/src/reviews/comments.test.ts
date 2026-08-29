import { describe, expect, it } from 'vitest';

import {
    createReviewCommentLinkedIssueIdV1,
    createReviewCommentFingerprintV1,
    defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema,
    defineReviewCommentRevisionedSingleEntryPublicationPlanV1ProtocolSchema,
    parseReviewCommentPublicationPlanV1,
    preflightReviewCommentPublicationRoutingV1,
    redactReviewCommentSensitiveText,
    ReviewCommentPublicationPlanV1ProtocolSchema,
    ReviewCommentPublicationResultV1ProtocolSchema,
    ReviewCommentUnversionedSingleEntryPublicationPlanV1ProtocolSchema,
} from './comments.js';
import {
    defineProtocolLiteral,
    defineProtocolString,
    defineProtocolUnion,
} from '../protocol/index.js';

const publicationPlan = {
    target: {
        providerId: 'github',
        configuredAccountId: 'github-account-1',
        entryRef: {
            sourceId: 'github',
            kindId: 'pull-request',
            collisionScope: 'github:repository-1',
            entryId: '42',
        },
        subtarget: null,
    },
    baseRevision: 'base-1',
    headRevision: 'head-1',
    entries: [],
    verdict: { kind: 'approve' as const, body: 'Looks good.' },
};

describe('review comment helpers', () => {
    it('qualifies issue links beyond a provider-local number', () => {
        const base = {
            source: { pluginId: 'happier.scm.github', localId: 'github' },
            kindId: 'issue',
            entryId: '42',
        } as const;
        expect(createReviewCommentLinkedIssueIdV1({
            ...base,
            collisionScope: 'github:example/repository',
        })).not.toBe(createReviewCommentLinkedIssueIdV1({
            ...base,
            collisionScope: 'github:other/repository',
        }));
    });

    it('publishes closed manifest schemas for plans and exact-cardinality results', () => {
        expect(ReviewCommentPublicationPlanV1ProtocolSchema.safeParse(publicationPlan).success).toBe(true);
        expect(ReviewCommentPublicationPlanV1ProtocolSchema.safeParse({
            ...publicationPlan,
            verdict: null,
        }).success).toBe(false);

        for (const kindId of ['review-thread', 'review-comment', 'repository']) {
            const candidate = {
                ...publicationPlan,
                target: {
                    ...publicationPlan.target,
                    subtarget: { kindId, targetId: 'nested-1' },
                },
            };
            const manifestAccepted = ReviewCommentPublicationPlanV1ProtocolSchema.safeParse(candidate).success;
            let runtimeAccepted = true;
            try {
                parseReviewCommentPublicationPlanV1(candidate);
            } catch {
                runtimeAccepted = false;
            }
            expect(manifestAccepted).toBe(runtimeAccepted);
        }

        const githubRevisioned = defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema(
            defineProtocolString({ pattern: '^[0-9a-f]{7,64}$' }),
        );
        expect(githubRevisioned.safeParse({
            ...publicationPlan,
            baseRevision: 'abcdef1',
            headRevision: '1234567',
        }).success).toBe(true);
        expect(githubRevisioned.safeParse({
            ...publicationPlan,
            baseRevision: null,
            headRevision: null,
        }).success).toBe(false);
        expect(githubRevisioned.safeParse({
            ...publicationPlan,
            baseRevision: 'abcdef1',
            headRevision: '1234567',
            verdict: { kind: 'requestChanges', body: 'Please revise.' },
        }).success).toBe(true);
        const providerNarrowed = defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema(
            defineProtocolString({ pattern: '^[0-9a-f]{7,64}$' }),
            defineProtocolUnion([
                defineProtocolLiteral('approve'),
                defineProtocolLiteral('comment'),
            ]),
        );
        expect(providerNarrowed.safeParse({
            ...publicationPlan,
            baseRevision: 'abcdef1',
            headRevision: '1234567',
            verdict: { kind: 'requestChanges', body: 'Please revise.' },
        }).success).toBe(false);
        const githubSingleComment = defineReviewCommentRevisionedSingleEntryPublicationPlanV1ProtocolSchema(
            defineProtocolString({ pattern: '^[0-9a-f]{7,64}$' }),
        );
        const singleEntry = {
            happierCommentId: 'comment-1',
            expectedServerRevision: 1,
            anchor: { kind: 'file' as const, filePath: 'src/example.ts' },
            snapshot: {
                kind: 'too_large' as const,
                filePath: 'src/example.ts',
                sizeBytes: 12,
                capBytes: 8,
                capturedAt: 1,
            },
            body: 'Publish one comment.',
        };
        expect(githubSingleComment.safeParse({
            ...publicationPlan,
            baseRevision: 'abcdef1',
            headRevision: '1234567',
            entries: [singleEntry],
            verdict: null,
        }).success).toBe(true);
        expect(githubSingleComment.safeParse({
            ...publicationPlan,
            baseRevision: 'abcdef1',
            headRevision: '1234567',
            entries: [singleEntry, { ...singleEntry, happierCommentId: 'comment-2' }],
            verdict: null,
        }).success).toBe(false);
        expect(ReviewCommentUnversionedSingleEntryPublicationPlanV1ProtocolSchema.safeParse({
            ...publicationPlan,
            baseRevision: null,
            headRevision: null,
            entries: [singleEntry],
            verdict: null,
        }).success).toBe(true);
        expect(githubRevisioned.safeParse({
            ...publicationPlan,
            baseRevision: 'not-a-sha',
            headRevision: '1234567',
        }).success).toBe(false);
        expect(ReviewCommentPublicationPlanV1ProtocolSchema.safeParse({
            ...publicationPlan,
            unexpected: true,
        }).success).toBe(false);
        expect(ReviewCommentPublicationPlanV1ProtocolSchema.safeParse({
            ...publicationPlan,
            baseRevision: null,
            headRevision: null,
            entries: [{
                happierCommentId: 'comment-1',
                expectedServerRevision: 1,
                anchor: { kind: 'file', filePath: 'src/example.ts' },
                snapshot: {
                    kind: 'too_large',
                    filePath: 'src/example.ts',
                    sizeBytes: 12,
                    capBytes: 8,
                    capturedAt: 1,
                },
                body: 'Publish as an issue comment.',
            }],
            verdict: null,
        }).success).toBe(true);
        expect(ReviewCommentPublicationPlanV1ProtocolSchema.safeParse({
            ...publicationPlan,
            headRevision: null,
        }).success).toBe(false);

        expect(ReviewCommentPublicationResultV1ProtocolSchema.safeParse({
            publicationPlanId: 'p'.repeat(43),
            entries: [],
            verdict: {
                publicationCorrelationId: 'v'.repeat(43),
                outcome: { kind: 'published', externalRef: 'native-review-1' },
            },
        }).success).toBe(true);
        expect(ReviewCommentPublicationResultV1ProtocolSchema.safeParse({
            publicationPlanId: 'p'.repeat(43),
            entries: [],
            verdict: {
                publicationCorrelationId: 'v'.repeat(43),
                outcome: { kind: 'published' },
            },
        }).success).toBe(true);
        expect(ReviewCommentPublicationResultV1ProtocolSchema.safeParse({
            publicationPlanId: 'p'.repeat(43),
            entries: [],
            verdict: {
                publicationCorrelationId: 'v'.repeat(43),
                outcome: { kind: 'uncertain', externalRef: 'published-summary-1' },
            },
        }).success).toBe(true);
        expect(ReviewCommentPublicationResultV1ProtocolSchema.safeParse({
            publicationPlanId: 'not-a-correlation',
            entries: [],
            verdict: { kind: 'notRequested' },
        }).success).toBe(false);
    });

    it('publishes the canonical diff-less pre-claim routing helper', () => {
        const plan = parseReviewCommentPublicationPlanV1({
            ...publicationPlan,
            entries: [{
                happierCommentId: 'comment-1',
                expectedServerRevision: 1,
                anchor: { kind: 'finding', runId: 'run-1', findingId: 'finding-1' },
                snapshot: {
                    kind: 'too_large',
                    filePath: 'src/example.ts',
                    sizeBytes: 12,
                    capBytes: 8,
                    capturedAt: 1,
                },
                body: 'This finding has no file-scoped comment route.',
            }],
        });
        expect(preflightReviewCommentPublicationRoutingV1(plan)).toEqual({
            kind: 'ready',
            inlineEntryIndexes: [],
            verdictSummaryEntryIndexes: [0],
        });
    });

    it('redacts diagnostic secrets from review comment text', () => {
        const redacted = redactReviewCommentSensitiveText(
            'AUTH_TOKEN=abc123 --api-key live-secret custom-secret',
            { redactedValues: ['custom-secret'] },
        );

        expect(redacted).toContain('AUTH_TOKEN=[REDACTED]');
        expect(redacted).toContain('--api-key [REDACTED]');
        expect(redacted).not.toContain('abc123');
        expect(redacted).not.toContain('live-secret');
        expect(redacted).not.toContain('custom-secret');
    });

    it('builds stable fingerprints from normalized message and anchor content', () => {
        const first = createReviewCommentFingerprintV1({
            ruleId: ' Security ',
            anchor: { kind: 'line', filePath: ' src/auth.ts ', line: 42 },
            message: 'Validate   TOKEN=first before use.',
            engineId: 'coderabbit',
        });
        const second = createReviewCommentFingerprintV1({
            ruleId: 'security',
            anchor: { kind: 'line', filePath: 'src/auth.ts', line: 42 },
            message: ' validate token=second before use. ',
            engineId: 'coderabbit',
        });

        expect(first.normalizedMessageHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first.normalizedMessageHash).toBe(
            '4c4ce31d82f3ba5bbc1ab4b5b65216a5efd413dc6571556108d0bb219ba907de',
        );
        expect(first.normalizedMessageHash).toBe(second.normalizedMessageHash);
        expect(first.lineRange).toEqual({ startLine: 42, endLine: 42 });
        expect(JSON.stringify(first)).not.toContain('first');
        expect(JSON.stringify(second)).not.toContain('second');
    });
});
