import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { CollectionEntityKindV1 } from './collectionSpacesV1.js';

/** Deliberate Account preferences; selection remains with device-local navigation. */
export const CollectionSpacesEnabledV1Schema = lazyZodSchema(() => z.boolean());
export const COLLECTION_SPACE_ENABLEMENT_SETTING_KEYS_V1 = {
    sessionWork: 'sessionSpacesEnabled',
    workflow: 'workflowSpacesEnabled',
    discussion: 'discussionSpacesEnabled',
} as const satisfies Record<CollectionEntityKindV1, string>;
