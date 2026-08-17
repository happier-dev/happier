import { z } from 'zod';

import { PLUGIN_COLLECTION_LIMITS_V1 } from '../../../plugins/data/collectionLimitsV1.js';

/**
 * Deployment ceilings advertised for diagnostic Collection preflight only.
 * The server mutation transaction remains the enforcement owner.
 */
export const PluginDataCollectionsCapabilitiesSchema = z.strictObject({
  maxRowEncodedBytes: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumStoredRowEncodedBytes),
  maxBatchBytes: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchEncodedBytes),
  maxBatchRows: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows),
  maxAccountRows: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountRows),
  maxAccountBytes: z.number().int().positive().max(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountEncodedBytes),
}).superRefine((value, context) => {
  if (value.maxRowEncodedBytes > value.maxBatchBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxRowEncodedBytes'],
      message: 'Collection row limit cannot exceed the batch byte limit.',
    });
  }
  if (value.maxBatchBytes > value.maxAccountBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxBatchBytes'],
      message: 'Collection batch byte limit cannot exceed the Account byte limit.',
    });
  }
  if (value.maxBatchRows > value.maxAccountRows) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxBatchRows'],
      message: 'Collection batch row limit cannot exceed the Account row limit.',
    });
  }
});

export type PluginDataCollectionsCapabilities = z.infer<
  typeof PluginDataCollectionsCapabilitiesSchema
>;
