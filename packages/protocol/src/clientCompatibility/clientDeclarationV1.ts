import { z } from 'zod';
import { ClientAppVersionSchema, ClientKindSchema, ClientReleaseChannelSchema, SessionSyncProtocolVersionSchema } from './primitives.js';

export const ClientCompatibilityDeclarationV1Schema = z.object({
  v: z.literal(1),
  clientKind: ClientKindSchema,
  appVersion: ClientAppVersionSchema,
  releaseChannel: ClientReleaseChannelSchema.optional(),
  sessionSyncProtocolVersion: SessionSyncProtocolVersionSchema,
}).strict();
export type ClientCompatibilityDeclarationV1 = z.infer<typeof ClientCompatibilityDeclarationV1Schema>;
