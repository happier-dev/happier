import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';
import { ReviewSourceKindV1Schema, ReviewSubjectKindV1Schema, ReviewRoundStateV1Schema } from './reviewArtifactV1.js';
import { compileEntityListFilterV1, createEntityListFilterStoredReadSchemaV1, matchEntityFilterKnownV1 } from '../collections/filter/entityListFilterV1.js';
import { createEntityFilterConditionCodecV1, defineEntityFilterFieldV1, defineEntityFilterUnknownFieldsV1 } from '../collections/filter/fieldRegistryV1.js';

const Id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
/** Server-readable Review metadata only. Personal space membership is a separate organization predicate. */
export const ReviewListFilterV1Schema = lazyZodSchema(() => z.strictObject({
    projectSourceId: z.optional(Id), subjectKind: z.optional(ReviewSubjectKindV1Schema),
    sourceKind: z.optional(ReviewSourceKindV1Schema), state: z.optional(ReviewRoundStateV1Schema),
    workflowId: z.optional(Id), needsDecision: z.optional(z.boolean()), sharedWithTeamId: z.optional(Id),
}));
export type ReviewListFilterV1 = z.infer<typeof ReviewListFilterV1Schema>;
export const ReviewListFilterV1StoredSchema = lazyZodSchema(() => createEntityListFilterStoredReadSchemaV1(ReviewListFilterV1Schema));
defineStoredReadProjection(ReviewListFilterV1Schema, () => ReviewListFilterV1StoredSchema);
export const DEFAULT_REVIEW_LIST_FILTER_V1: ReviewListFilterV1 = Object.freeze({});
export type ReviewListFilterFactsV1 = ReviewListFilterV1;
type Key = keyof ReviewListFilterV1;
type Selection = Exclude<ReviewListFilterV1[Key], undefined>;
const keys = Object.keys(ReviewListFilterV1Schema.shape) as Key[];
export const reviewListFilterFieldsV1 = [
    ...keys.map(id => defineEntityFilterFieldV1<ReviewListFilterV1, ReviewListFilterFactsV1, Selection>({
        id, kind: id === 'needsDecision' ? 'boolean' : 'domain', evaluators: ['list'],
        readSelection: filter => filter[id], replaceSelection: (filter, selection) => ({ ...filter, [id]: selection }),
        match: (selection, facts) => matchEntityFilterKnownV1(facts[id] === undefined ? undefined : facts[id] === selection),
        conditions: createEntityFilterConditionCodecV1({ encoding: 'value', parseValue: value => {
            const parsed = ReviewListFilterV1Schema.shape[id].parse(value);
            if (parsed === undefined) throw new TypeError('A Review filter condition requires a value');
            return parsed;
        } }),
    })),
    defineEntityFilterUnknownFieldsV1<ReviewListFilterV1, ReviewListFilterFactsV1>(keys),
];
export function compileReviewListFilterV1(filter: ReviewListFilterV1) {
    return compileEntityListFilterV1(reviewListFilterFieldsV1, filter, 'list');
}
