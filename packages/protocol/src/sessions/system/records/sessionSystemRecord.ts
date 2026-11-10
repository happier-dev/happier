import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { SessionSystemRecordAddressSchema } from './sessionSystemRecordAddress.js';
import { SessionSystemRecordRevisionSchema } from './sessionSystemRecordRevision.js';

export const SessionSystemRecordSchema = lazyZodSchema(() => z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    address: SessionSystemRecordAddressSchema,
    content: StrictJsonValueSchema,
    revision: SessionSystemRecordRevisionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }));
export type SessionSystemRecord = z.infer<typeof SessionSystemRecordSchema>;
