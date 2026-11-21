import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DeploySuggestionCatalogV1Schema, DeploySuggestionCheckActionResultV1Schema, DeploySuggestionRecommendationV1Schema } from './deploySuggestionsV1.js';
import { DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '../deploymentActionIdsV1.js';

export const DeploymentSuggestionActionInputSchemasV1 = {
    [DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1]: lazyZodSchema(() => z.strictObject({
        projection: z.optional(z.literal('forges')),
    })),
    // The input declares the suggestion it checks, so a Session agent reads its shape and a wrong one is refused by
    // field (AUTO-LIVE step 8: a bare array was admitted and answered with no cards). The one validator still decides ids,
    // pairs and prices. The check reads the current catalog itself: a Session agent cannot echo the whole catalog back as
    // tool input (F-S8-SNAPSHOT). `description` is the person's own words, carried unchanged to the build Session's first
    // message; the validator ignores it. Questions go through the agent's own ask-user-question tool, not the check.
    [DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1]: lazyZodSchema(() => z.strictObject({
        suggestion: z.strictObject({ recommendations: z.array(DeploySuggestionRecommendationV1Schema) }),
        description: z.optional(z.string()),
    })),
};
export const DeploymentSuggestionActionOutputSchemasV1 = {
    [DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1]: DeploySuggestionCatalogV1Schema,
    [DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1]: DeploySuggestionCheckActionResultV1Schema,
};
