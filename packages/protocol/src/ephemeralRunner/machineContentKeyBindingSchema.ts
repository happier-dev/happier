import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { RunnerPublicKeySchema, RunnerResourceIdSchema, RunnerSignatureSchema } from './activation.js';

export const RUNNER_MACHINE_CONTENT_KEY_FINGERPRINT_PREFIX = 'runner-machine-content-key-sha256:' as const;

export const RunnerMachineContentKeyFingerprintV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^runner-machine-content-key-sha256:[a-f0-9]{64}$/)));

export const RunnerMachineContentKeyBindingPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-runner.machine-content-key'),
  homeServerIdentityId: RunnerResourceIdSchema,
  activationId: z.string().check(z.uuid()),
  creatorAccountId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
  installationId: RunnerResourceIdSchema,
  machineContentKeyFingerprint: RunnerMachineContentKeyFingerprintV1Schema,
}));
export type RunnerMachineContentKeyBindingPayloadV1 = z.infer<
  typeof RunnerMachineContentKeyBindingPayloadV1Schema
>;

/**
 * Creator-sealed verifier fact carried beside the signature.
 *
 * The signed payload authenticates the Machine content key against the
 * creator's activation signing identity, but a reader that never held creator
 * device custody has no trusted copy of that identity. This optional field
 * carries it under the Account-scoped cipher, so every authorized DataKey or
 * legacy device of the same Account recovers it and no Home can forge or alter
 * it. It is outside the signed payload by construction: the creator seals it
 * after signing, and both the signer and the verifier ignore it.
 */
export const RunnerMachineContentKeyVerifierFactPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  activationId: z.string().check(z.uuid()),
  machineId: RunnerResourceIdSchema,
  activationSigningPublicKey: RunnerPublicKeySchema,
}));
export type RunnerMachineContentKeyVerifierFactPayloadV1 = z.infer<
  typeof RunnerMachineContentKeyVerifierFactPayloadV1Schema
>;

export const RunnerMachineContentKeyBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RunnerMachineContentKeyBindingPayloadV1Schema, {
  accountSignatureBase64Url: RunnerSignatureSchema,
  /** Account-sealed `RunnerMachineContentKeyVerifierFactPayloadV1`; never signed. */
  creatorVerifierFactCiphertext: z.optional(z.string().check(z.minLength(1), z.maxLength(4096))),
})));
export type RunnerMachineContentKeyBindingV1 = z.infer<typeof RunnerMachineContentKeyBindingV1Schema>;

/** The non-signature fields the activation signature actually covers. */
export function readRunnerMachineContentKeyBindingSignedPayloadV1(
  value: unknown,
): RunnerMachineContentKeyBindingPayloadV1 | null {
  if (value === null || typeof value !== 'object') return null;
  const {
    accountSignatureBase64Url: _signature,
    creatorVerifierFactCiphertext: _fact,
    ...payload
  } = value as Record<string, unknown>;
  const parsed = RunnerMachineContentKeyBindingPayloadV1Schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
