import { z } from '../zodRuntimePolicy.js';

import { RunnerResourceIdSchema, RunnerSha256CommitmentSchema } from './activation.js';
import { RunnerMachineContentKeyBindingV1Schema } from './machineContentKeyBindingSchema.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';

const RuntimeBootstrapCommonV1Schema = z.strictObject({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.runtime'),
  homeServerIdentityId: RunnerResourceIdSchema,
  activationId: z.string().check(z.uuid()),
  creatorAccountId: RunnerResourceIdSchema,
  sessionId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
  installationId: RunnerResourceIdSchema,
  launchManifestCommitment: RunnerSha256CommitmentSchema,
});

const Key32Base64UrlSchema = z.string().check(z.length(43), z.refine((value) => decodeCanonicalBase64UrlFixedLength(value, 32) !== null, 'Expected canonical unpadded base64url key'));

export const RunnerRuntimeBootstrapV1Schema = z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RuntimeBootstrapCommonV1Schema, {
    storedContent: z.strictObject({ mode: z.literal('plain') }),
    machineContent: z.strictObject({ mode: z.literal('plain') }),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RuntimeBootstrapCommonV1Schema, {
    storedContent: z.strictObject({ mode: z.literal('e2ee'), sessionDataEncryptionKey: Key32Base64UrlSchema }),
    machineContent: z.strictObject({
      mode: z.literal('e2ee'),
      machineContentKeyBase64Url: Key32Base64UrlSchema,
      binding: RunnerMachineContentKeyBindingV1Schema,
    }),
  })),
]);
export type RunnerRuntimeBootstrapV1 = z.infer<typeof RunnerRuntimeBootstrapV1Schema>;
