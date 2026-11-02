import { z } from 'zod/mini';
import { SessionIdSchema } from '../idsV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionSystemRecordAddressSchema } from '../system/records/sessionSystemRecordAddress.js';

/** A missing address revalidates the Session's records and access. No content travels here. */
export const SessionSystemRecordInvalidationV1Schema = z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  address: z.optional(SessionSystemRecordAddressSchema),
});
export type SessionSystemRecordInvalidationV1 = z.infer<typeof SessionSystemRecordInvalidationV1Schema>;


/** Content-free wake hint; ordinary Session changes also invalidate surface reads. */
export const SessionSurfacesChangeHintV1Schema = z.strictObject({
  v: z.literal(1),
  sessionSurfaces: z.literal(true),
});
export type SessionSurfacesChangeHintV1 = z.infer<typeof SessionSurfacesChangeHintV1Schema>;
