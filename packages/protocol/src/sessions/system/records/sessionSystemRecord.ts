import { z } from 'zod';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { SessionSystemRecordAddressSchema } from './sessionSystemRecordAddress.js';
import { SessionSystemRecordRevisionSchema } from './sessionSystemRecordRevision.js';

export const SessionSystemRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    address: SessionSystemRecordAddressSchema,
    content: StrictJsonValueSchema,
    revision: SessionSystemRecordRevisionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type SessionSystemRecord = z.infer<typeof SessionSystemRecordSchema>;
