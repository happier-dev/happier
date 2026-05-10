import { z } from 'zod';

import { SESSION_STATE_FIELD_CLASSES, SESSION_STATE_FIELD_IDS } from './_constants.js';

export const SessionStateFieldIdSchema = z.enum(SESSION_STATE_FIELD_IDS);
export const SessionStateFieldClassSchema = z.enum(SESSION_STATE_FIELD_CLASSES);

export const SessionStateFieldDescriptorSchema = z
  .object({
    id: SessionStateFieldIdSchema,
    class: SessionStateFieldClassSchema,
  })
  .strict();
