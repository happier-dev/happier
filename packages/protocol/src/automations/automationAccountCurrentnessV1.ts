import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import {
  AccountEncryptionCurrentnessResponseSchema,
  type AccountEncryptionCurrentnessResponse,
} from '../account/encryptionMode.js';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '../account/encryptionKeyFingerprintV1.js';
import type { AccountScopedCryptoMaterialSnapshotV1 } from '../crypto/accountScopedCipher.js';

import { AutomationNonnegativeSafeIntegerV1Schema } from './automationResultDeliveryV1.js';

/**
 * A non-secret witness from the canonical Account currentness endpoint. The
 * host binds it to private Automation content; plugin Action input never
 * supplies it.
 */
export const AutomationAccountCurrentnessWitnessV1Schema = lazyZodSchema(() => z.object({
  mode: AccountEncryptionModeSchema,
  version: AutomationNonnegativeSafeIntegerV1Schema,
  contentKeyFingerprint: z.string().min(1).max(256).nullable(),
}).strict().superRefine((value, context) => {
  if (
    (value.mode === 'plain' && value.contentKeyFingerprint !== null)
    || (value.mode === 'e2ee' && value.contentKeyFingerprint === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contentKeyFingerprint'],
      message: 'Account currentness mode and content-key fingerprint must agree',
    });
  }
}));
export type AutomationAccountCurrentnessWitnessV1 = z.infer<
  typeof AutomationAccountCurrentnessWitnessV1Schema
>;

type PlainAutomationAccountCurrentnessWitnessV1 =
  AutomationAccountCurrentnessWitnessV1 & Readonly<{
    mode: 'plain';
    contentKeyFingerprint: null;
  }>;

type E2eeAutomationAccountCurrentnessWitnessV1 =
  AutomationAccountCurrentnessWitnessV1 & Readonly<{
    mode: 'e2ee';
    contentKeyFingerprint: string;
  }>;

type AvailablePlainAutomationAccountEncryptionV1 = Readonly<{
  kind: 'available';
  witness: PlainAutomationAccountCurrentnessWitnessV1;
  material?: never;
}>;

export type AvailableE2eeAutomationAccountEncryptionV1 = Readonly<{
  kind: 'available';
  witness: E2eeAutomationAccountCurrentnessWitnessV1;
  material: AccountScopedCryptoMaterialSnapshotV1;
}>;

export type AvailableAutomationAccountEncryptionV1 =
  | AvailablePlainAutomationAccountEncryptionV1
  | AvailableE2eeAutomationAccountEncryptionV1;

export type ValidatedAutomationAccountEncryptionV1 =
  | AvailableAutomationAccountEncryptionV1
  | Readonly<{
    /** Currentness/material may recover after credential refresh or rekey. */
    kind: 'retry';
    witness: AutomationAccountCurrentnessWitnessV1;
  }>
  | Readonly<{ kind: 'unavailable' }>;

export function isAvailableE2eeAutomationAccountEncryptionV1(
  value: AvailableAutomationAccountEncryptionV1,
): value is AvailableE2eeAutomationAccountEncryptionV1 {
  return value.witness.mode === 'e2ee';
}

/**
 * Reads the canonical server currentness endpoint and admits local E2EE
 * material only when its Account key fingerprint is current. Plain mode is
 * intentionally keyless and never consults local encryption credentials.
 */
export async function resolveValidatedAutomationAccountEncryptionV1(params: Readonly<{
  signal: AbortSignal;
  resolveAccountEncryptionCurrentness: (
    signal?: AbortSignal,
  ) => Promise<AccountEncryptionCurrentnessResponse>;
  resolveAccountEncryptionMaterial: (
    signal?: AbortSignal,
  ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
}>): Promise<ValidatedAutomationAccountEncryptionV1> {
  let rawCurrentness: AccountEncryptionCurrentnessResponse;
  try {
    rawCurrentness = await params.resolveAccountEncryptionCurrentness(params.signal);
  } catch {
    return { kind: 'unavailable' };
  }
  if (params.signal.aborted) return { kind: 'unavailable' };
  const parsedCurrentness = AccountEncryptionCurrentnessResponseSchema.safeParse(rawCurrentness);
  if (!parsedCurrentness.success) return { kind: 'unavailable' };
  const currentness = parsedCurrentness.data;
  // A plain Account may still retain the content key of the E2EE state it
  // was migrated away from. The canonical projection owner normalizes that
  // retained fingerprint away before the witness is validated.
  const witness = projectAutomationAccountCurrentnessWitnessV1(currentness);
  if (witness === null) return { kind: 'unavailable' };

  if (witness.mode === 'plain') {
    return {
      kind: 'available',
      witness: {
        mode: 'plain',
        version: witness.version,
        contentKeyFingerprint: null,
      },
    };
  }

  let snapshot: AccountScopedCryptoMaterialSnapshotV1 | null;
  try {
    snapshot = await params.resolveAccountEncryptionMaterial(params.signal);
  } catch {
    return { kind: 'retry', witness };
  }
  if (params.signal.aborted) return { kind: 'unavailable' };
  if (snapshot === null || currentness.contentKeyFingerprint === null) {
    return { kind: 'retry', witness };
  }

  let localFingerprint: string;
  try {
    localFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      snapshot.contentPublicKeyFingerprint,
    );
  } catch {
    return { kind: 'retry', witness };
  }
  const e2eeWitness: E2eeAutomationAccountCurrentnessWitnessV1 = {
    mode: 'e2ee',
    version: witness.version,
    contentKeyFingerprint: currentness.contentKeyFingerprint,
  };
  return localFingerprint === currentness.contentKeyFingerprint
    ? { kind: 'available', witness: e2eeWitness, material: snapshot }
    : { kind: 'retry', witness: e2eeWitness };
}

/**
 * The one projection from a raw Account currentness reading to the Automation
 * witness. A supported plain Account may still retain the content public key of
 * the E2EE state it was migrated away from, so its canonical currentness
 * reading keeps reporting that fingerprint. Plain Automation content is
 * keyless, so the plain witness is normalized here — once, for every reader —
 * instead of letting each caller validate the raw retained fingerprint and
 * conclude that a current plain Account has no currentness.
 */
export function projectAutomationAccountCurrentnessWitnessV1(reading: Readonly<{
  mode: unknown;
  version: unknown;
  contentKeyFingerprint: unknown;
}>): AutomationAccountCurrentnessWitnessV1 | null {
  const parsed = AutomationAccountCurrentnessWitnessV1Schema.safeParse({
    mode: reading.mode,
    version: reading.version,
    contentKeyFingerprint: reading.mode === 'plain' ? null : reading.contentKeyFingerprint,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Exact witness equality. Pre-effect Automation decisions — claim, start,
 * session-server-start authorization, and redispatch permission — must match
 * the server's current Account state exactly, including its Account change
 * version. A terminal settlement that reports an already-committed external
 * effect compares content identity instead (see
 * {@link sameAutomationAccountContentIdentityV1}): the reported effect itself,
 * and any unrelated Account write, may have advanced the change version after
 * the echoed start witness was minted.
 */
export function sameAutomationAccountCurrentnessWitnessV1(
  left: AutomationAccountCurrentnessWitnessV1,
  right: AutomationAccountCurrentnessWitnessV1,
): boolean {
  return left.mode === right.mode
    && left.version === right.version
    && left.contentKeyFingerprint === right.contentKeyFingerprint;
}

/**
 * Account *content* identity: the mode and key under which Account-scoped
 * Automation content can be opened or sealed. The witness version is the
 * Account-wide change cursor and advances for unrelated Account writes, so a
 * reader that only has to prove "this content is still readable with the same
 * key" compares identity rather than the exact witness.
 */
export function sameAutomationAccountContentIdentityV1(
  left: AutomationAccountCurrentnessWitnessV1,
  right: AutomationAccountCurrentnessWitnessV1,
): boolean {
  return left.mode === right.mode
    && left.contentKeyFingerprint === right.contentKeyFingerprint;
}
