import tweetnacl from 'tweetnacl';
import { z } from '../zodRuntimePolicy.js';

import { HomeConnectionDescriptorV1Schema } from '../auth/accountDirectory.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { RunnerEndpointFactsRecipientV1Schema, RunnerResourceIdSchema, RunnerSha256CommitmentSchema } from './activation.js';
import { RunnerArtifactIdentityV1Schema } from './runnerArtifact.js';
import { TemporaryComputerWorkspaceV1Schema } from '../sessions/authoring/temporaryComputerWorkspaceV1.js';

const ActivationSigningPrivateKeySchema = z.string().check(z.length(86), z.refine((value) => {
  const secretKey = decodeCanonicalBase64UrlFixedLength(value, tweetnacl.sign.secretKeyLength);
  if (!secretKey) return false;
  const derived = tweetnacl.sign.keyPair.fromSeed(secretKey.subarray(0, tweetnacl.sign.seedLength));
  try {
    return tweetnacl.verify(derived.secretKey, secretKey);
  } finally {
    secretKey.fill(0);
    derived.secretKey.fill(0);
  }
}, 'Invalid activation signing key'));

export const HappierRunnerActivationFileV1Schema = z.strictObject({
  v: z.literal(1),
  home: HomeConnectionDescriptorV1Schema,
  activation: z.strictObject({
    id: z.string().check(z.uuid()),
    signingPrivateKeyBase64Url: ActivationSigningPrivateKeySchema,
    creatorAccountId: RunnerResourceIdSchema,
    creatorTokenEpoch: z.number().check(z.int(), z.nonnegative(), z.int()),
    activationExpiresAt: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())),
    workspace: TemporaryComputerWorkspaceV1Schema,
    sessionId: RunnerResourceIdSchema,
    machineId: RunnerResourceIdSchema,
    authoringCommitment: RunnerSha256CommitmentSchema,
    artifact: RunnerArtifactIdentityV1Schema,
    endpointFactsRecipient: RunnerEndpointFactsRecipientV1Schema,
  }).check(z.refine((activation) => activation.creatorAccountId === activation.endpointFactsRecipient.creatorAccountId, 'Recipient must belong to the authenticated creator')),
});
export type HappierRunnerActivationFileV1 = z.infer<typeof HappierRunnerActivationFileV1Schema>;

/** Parse decoded local JSON; callers must not report rejected file contents in errors or logs. */
export function parseHappierRunnerActivationFileV1(input: unknown): HappierRunnerActivationFileV1 | null {
  const parsed = HappierRunnerActivationFileV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
