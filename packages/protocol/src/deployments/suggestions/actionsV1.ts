import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DeploySuggestionCatalogV1Schema, DeploySuggestionCheckResultV1Schema } from './deploySuggestionsV1.js';
import { DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '../deploymentActionIdsV1.js';

export const DeploymentSuggestionActionInputSchemasV1 = {
    [DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1]: lazyZodSchema(() => z.strictObject({
        projection: z.optional(z.literal('forges')),
    })),
    // Keep the model result untrusted until the one validator can drop individual bad recommendations.
    // `description` is the person's own words, carried unchanged to the build Session's first message; the validator ignores it.
    [DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1]: lazyZodSchema(() => z.strictObject({
        catalog: DeploySuggestionCatalogV1Schema, suggestion: z.unknown(), description: z.optional(z.string()),
    })),
};
export const DeploymentSuggestionActionOutputSchemasV1 = {
    [DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1]: DeploySuggestionCatalogV1Schema,
    [DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1]: DeploySuggestionCheckResultV1Schema,
};
