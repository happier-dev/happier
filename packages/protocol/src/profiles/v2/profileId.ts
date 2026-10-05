import { z } from 'zod';

import {
  createProtocolComposableSchema,
  ProtocolValidationError,
} from '../../plugins/actions/protocolComposableSchema.js';

/** The Launch Profile V2 owner's existing trim and UTF-16 length contract. */
export const LaunchProfileIdV2Schema = z.string().trim().min(1).max(256);

/** Neutral projection of the same parser, for references embedded in Action inputs. */
export const LaunchProfileIdV2ProtocolSchema = createProtocolComposableSchema<string, string>(
  // Zod's non-enumerable Standard Schema annotation is not part of the JSON projection.
  { ...z.toJSONSchema(LaunchProfileIdV2Schema, { io: 'input', target: 'draft-7' }) },
  (input) => {
    const parsed = LaunchProfileIdV2Schema.safeParse(input);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false, error: new ProtocolValidationError(parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: [],
      }))) };
  },
);
