import { z } from '../zodRuntimePolicy.js';

import { RunnerPublicKeySchema, RunnerResourceIdSchema } from './activation.js';

export const VerifiedEphemeralSessionRunnerPrincipalSchema = z.readonly(z.strictObject({
  kind: z.literal('ephemeral_session_runner'),
  authority: z.literal('session_runtime'),
  accountId: RunnerResourceIdSchema,
  activationId: z.string().check(z.uuid()),
  sessionId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
  installationId: RunnerResourceIdSchema,
  installationPublicKey: RunnerPublicKeySchema,
  creatorTokenEpoch: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
export type VerifiedEphemeralSessionRunnerPrincipal = z.infer<typeof VerifiedEphemeralSessionRunnerPrincipalSchema>;
