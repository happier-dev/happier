import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SESSION_STATE_FIELD_CLASSES, SESSION_STATE_FIELD_IDS } from './_constants.js';

export const SessionStateFieldIdSchema = lazyZodSchema(() => z.enum(SESSION_STATE_FIELD_IDS));
export const SessionStateFieldClassSchema = lazyZodSchema(() => z.enum(SESSION_STATE_FIELD_CLASSES));
export const SessionStateFieldDeliveryClassSchema = lazyZodSchema(() => z.enum([
  'durable_required',
  'durable_best_effort',
  'ephemeral_drop_ok',
]));

export const SessionStateFieldDescriptorSchema = lazyZodSchema(() => z.strictObject({
    id: SessionStateFieldIdSchema,
    class: SessionStateFieldClassSchema,
    deliveryClass: SessionStateFieldDeliveryClassSchema,
  }));
