import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { CoordinationMessageRefV1Schema } from '../discussions/references.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { ActionRequestRequesterV1Schema } from './actionActorV1.js';

/** Content-free host projection of one admitted cause. Never execution or approval authority. */
export const ActionRequestAttributionV1Schema = lazyZodSchema(() => z.strictObject({
  requestRef: z.string().check(z.minLength(1)),
  requester: z.nullable(ActionRequestRequesterV1Schema),
  persona: SessionMessageRefV1Schema.shape.session,
  origin: z.nullable(CoordinationMessageRefV1Schema),
}));
export type ActionRequestAttributionV1 = Readonly<z.infer<typeof ActionRequestAttributionV1Schema>>;
