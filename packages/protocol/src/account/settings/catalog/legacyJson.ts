import { z } from 'zod';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import {
  ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES,
  ACCOUNT_SETTING_MAX_NESTING_DEPTH,
  ACCOUNT_SETTING_MAX_STRING_BYTES,
} from './accountSettingBounds.js';

export type BoundedLegacyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly BoundedLegacyJsonValue[]
  | { readonly [key: string]: BoundedLegacyJsonValue };

function createBoundedLegacyJsonValueSchema(depthRemaining: number): z.ZodType<BoundedLegacyJsonValue> {
  const scalar = z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(ACCOUNT_SETTING_MAX_STRING_BYTES),
  ]);
  if (depthRemaining === 0) return scalar;

  const child = createBoundedLegacyJsonValueSchema(depthRemaining - 1);
  return z.union([
    scalar,
    z.array(child).max(ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES),
    z.record(z.string().max(ACCOUNT_SETTING_MAX_STRING_BYTES), child)
      .superRefine((value, ctx) => {
        if (Object.keys(value).length > ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `contains more than ${ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES} record entries`,
          });
        }
      }),
  ]);
}

/**
 * Compatibility-only JSON carrier for retained entity-shaped Account roots. It is bounded and
 * preserves an accepted value exactly; it never interprets a future or malformed provider shape
 * as the current provider contract.
 */
export const BoundedLegacyJsonValueSchema = createBoundedLegacyJsonValueSchema(
  ACCOUNT_SETTING_MAX_NESTING_DEPTH,
);

/**
 * Provider settings are carried through Account Settings verbatim. The Provider
 * schemas own this subtree's cardinality and nesting, so the carrier only has to
 * preserve strict JSON data exactly; the Account byte ceiling is applied by the
 * catalog definition. Reusing the Protocol's one strict JSON value keeps the
 * prototype, accessor, dense-array, finite-number and cycle guarantees without a
 * second JSON walker.
 */
export const ProviderSettingsLegacySubtreeV1Schema = StrictJsonValueSchema.optional();
