import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '../features/payload/responseLimits.js';
import { AuthProviderIdSchema } from './providers.js';

const AUTH_METHOD_ID_UTF8_ENCODER = new TextEncoder();

/** Bounded exact authentication method/provider instance identifier used by auth entry and Team policy. */
export const AuthEntryMethodIdV1Schema = lazyZodSchema(() => AuthProviderIdSchema.superRefine((value, context) => {
  if (AUTH_METHOD_ID_UTF8_ENCODER.encode(value).byteLength > FEATURES_RESPONSE_MAX_UTF8_BYTES_V1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Auth entry method id exceeds response byte budget' });
  }
}));
