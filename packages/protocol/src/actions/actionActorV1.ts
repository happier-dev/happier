import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral } from '../plugins/actions/protocolComposableSchema.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { SessionMessageActorAccountIdV1Schema } from '../sessions/messages/sessionMessageActorAccountIdV1.js';

/** Qualified authenticated person, independent of the eventual executing persona. */
export const ActionRequestRequesterV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: SessionMessageRefV1Schema.shape.session.shape.serverId,
  accountId: SessionMessageActorAccountIdV1Schema,
}));

/** Private historical actor references; display names remain with their existing content owners. */
export const ActionActorV1Schema = lazyZodSchema(() => z.union([
  // Targeted contribution manifests reconstruct parsers from canonical literal projections.
  z.strictObject({ actorKind: asProtocolZod(defineProtocolLiteral('person')), accountId: ActionRequestRequesterV1Schema.shape.accountId }),
  z.strictObject({ actorKind: asProtocolZod(defineProtocolLiteral('agent')), sessionId: SessionMessageRefV1Schema.shape.session.shape.sessionId,
    onBehalfOf: z.optional(ActionRequestRequesterV1Schema) }),
  z.strictObject({ actorKind: asProtocolZod(defineProtocolLiteral('workflow')), runId: z.string().check(z.minLength(1)),
    automationId: z.optional(z.string().check(z.minLength(1))), onBehalfOf: z.optional(ActionRequestRequesterV1Schema) }),
]));
export type ActionActorV1 = Readonly<z.infer<typeof ActionActorV1Schema>>;
