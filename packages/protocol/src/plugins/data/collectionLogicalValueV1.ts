import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginCollectionMemberNameV1Schema } from './collectionContributionV1.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';

export const AccountDataCollectionValueV1Schema = lazyZodSchema(() => z.record(
  PluginCollectionMemberNameV1Schema,
  PluginUiJsonValueV1Schema,
).check(z.superRefine((value, context) => {
  if (Object.keys(value).length === 0) context.addIssue({ code: 'custom', message: 'Collection values must contain at least one field.' });
})));
