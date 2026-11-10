import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  ConnectedAccountServiceKeyIngressSchema,
  ConnectedServiceBindingsV2IngressSchema,
} from './connectedServiceBindings.js';
import { SessionTeamCredentialBindingIntentsV1Schema } from '../teams/credentials/sessionBindingIntentV1.js';

export const SessionConnectedServiceAuthSwitchRpcParamsSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  agentId: z.string().check(z.trim(), z.minLength(1)),
  // Current callers write V2. Released V1 callers remain a required
  // new-daemon/old-client ingress and normalize before domain logic.
  bindings: ConnectedServiceBindingsV2IngressSchema,
  // Released V1 callers name the same services by scalar id in these adjacent
  // fields too, so they normalize through the one Connected Account service
  // key ingress rather than requiring the qualified key `bindings` accepts.
  rematerializeServiceId: z.optional(ConnectedAccountServiceKeyIngressSchema),
  expectedGroupGenerationByServiceId: z.optional(z.record(
    ConnectedAccountServiceKeyIngressSchema,
    z.number().check(z.int(), z.nonnegative()),
  )),
  teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema.check(z.minLength(1))),
  previousTeamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema.check(z.minLength(1))),
  teamVisibilityGrantConsent: z.optional(z.strictObject({ teamId: z.string().check(z.minLength(1)) })),
  accountSettingsVersionHint: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

export type SessionConnectedServiceAuthSwitchRpcParams = z.infer<
  typeof SessionConnectedServiceAuthSwitchRpcParamsSchema
>;
