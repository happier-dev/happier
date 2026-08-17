import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    ReviewFindingsV2Schema as ProtocolReviewFindingsV2Schema,
    ReviewFindingSchema as ProtocolReviewFindingSchema,
    ReviewScmScopeV1Schema as ProtocolReviewScmScopeV1Schema,
    ReviewStartInputSchema as ProtocolReviewStartInputSchema,
    parseReviewFindingsV2 as protocolParseReviewFindingsV2,
    type ReviewFinding as ProtocolReviewFinding,
    type ReviewFindingId as ProtocolReviewFindingId,
    type ReviewFindingsV2 as ProtocolReviewFindingsV2,
    type ReviewScmScopeV1 as ProtocolReviewScmScopeV1,
    type ReviewStartInput as ProtocolReviewStartInput,
} from '@happier-dev/protocol';

import {
    ReviewFindingsV2Schema,
    ReviewFindingSchema,
    ReviewScmScopeV1Schema,
    ReviewStartInputSchema,
    createReviewCommentFingerprint,
    parseReviewFindingsV2,
    type CreateReviewCommentFingerprintInput,
    type ReviewFinding,
    type ReviewFindingId,
    type ReviewFindingsV2,
    type ReviewScmScopeV1,
    type ReviewStartInput,
} from './index.js';
import {
    createReviewCommentFingerprint as sourceCreateReviewCommentFingerprint,
    type CreateReviewCommentFingerprintInput as SourceCreateReviewCommentFingerprintInput,
} from './comments.js';
import {
    ReviewFindingsV2Schema as ProjectedReviewFindingsV2Schema,
    ReviewFindingSchema as ProjectedReviewFindingSchema,
    ReviewStartInputSchema as ProjectedReviewStartInputSchema,
    parseReviewFindingsV2 as projectedParseReviewFindingsV2,
    type ReviewFinding as ProjectedReviewFinding,
    type ReviewFindingId as ProjectedReviewFindingId,
    type ReviewFindingsV2 as ProjectedReviewFindingsV2,
    type ReviewStartInput as ProjectedReviewStartInput,
} from './projections.js';

describe('review package-local projections', () => {
    it('re-exports Protocol values by identity', () => {
        expect(ProjectedReviewFindingSchema).toBe(ProtocolReviewFindingSchema);
        expect(ProjectedReviewFindingsV2Schema).toBe(ProtocolReviewFindingsV2Schema);
        expect(ProjectedReviewStartInputSchema).toBe(ProtocolReviewStartInputSchema);
        expect(projectedParseReviewFindingsV2).toBe(protocolParseReviewFindingsV2);

        expect(ReviewFindingSchema).toBe(ProtocolReviewFindingSchema);
        expect(ReviewFindingsV2Schema).toBe(ProtocolReviewFindingsV2Schema);
        expect(ReviewStartInputSchema).toBe(ProtocolReviewStartInputSchema);
        expect(parseReviewFindingsV2).toBe(protocolParseReviewFindingsV2);
        expect(ReviewScmScopeV1Schema).toBe(ProtocolReviewScmScopeV1Schema);
    });

    it('preserves Protocol and existing SDK type identities', () => {
        expectTypeOf<ProjectedReviewFinding>().toEqualTypeOf<ProtocolReviewFinding>();
        expectTypeOf<ProjectedReviewFindingId>().toEqualTypeOf<ProtocolReviewFindingId>();
        expectTypeOf<ProjectedReviewFindingsV2>().toEqualTypeOf<ProtocolReviewFindingsV2>();
        expectTypeOf<ProjectedReviewStartInput>().toEqualTypeOf<ProtocolReviewStartInput>();

        expectTypeOf<ReviewFinding>().toEqualTypeOf<ProtocolReviewFinding>();
        expectTypeOf<ReviewFindingId>().toEqualTypeOf<ProtocolReviewFindingId>();
        expectTypeOf<ReviewFindingsV2>().toEqualTypeOf<ProtocolReviewFindingsV2>();
        expectTypeOf<ReviewStartInput>().toEqualTypeOf<ProtocolReviewStartInput>();
        expectTypeOf<ReviewScmScopeV1>().toEqualTypeOf<ProtocolReviewScmScopeV1>();
        expectTypeOf<CreateReviewCommentFingerprintInput>()
            .toEqualTypeOf<SourceCreateReviewCommentFingerprintInput>();
    });

    it('re-exports the fingerprint helper without a wrapper', () => {
        expect(createReviewCommentFingerprint).toBe(sourceCreateReviewCommentFingerprint);
    });
});
