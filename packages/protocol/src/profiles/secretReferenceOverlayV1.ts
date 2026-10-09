import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { isCanonicalProviderSavedSecretIdV1 } from '../providers/settings/v1.js';
import { EnvVarRequirementSchema } from './environmentVariables.js';

/**
 * One optional, value-free launch override for Saved Secret requirement
 * bindings. It carries the SAME reference vocabulary the persisted Profile
 * binding owner uses (`secretBindingsByProfileId`) plus the shared-resource
 * revision that decides currentness, and nothing else. It is not a secret
 * store, a Profile write, or a second custody model: the incumbent daemon
 * materializer remains the only thing that turns a reference into a value.
 */

/** The Profile requirement-name owner. Reused so there is one name vocabulary. */
const SecretRequirementNameSchema = EnvVarRequirementSchema.shape.name;

/**
 * Personal Saved Secrets have no revision — the materializer's record
 * fingerprint is their currentness. A shared resource reference must carry
 * its exact `SavedSecretCatalogResourceV1.revision`.
 */
export const SavedSecretReferenceV1Schema = lazyZodSchema(() => z.object({
  ref: z.string().refine(
    isCanonicalProviderSavedSecretIdV1,
    'Saved-secret reference must be canonical',
  ),
  revision: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  let kind: 'personal' | 'shared_resource';
  try {
    kind = parseSavedSecretRefV1(value.ref).kind;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ref'],
      message: 'Saved-secret reference must be a parsable V1 reference',
    });
    return;
  }
  if (kind === 'personal' && value.revision !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revision'],
      message: 'Personal Saved Secret references have no revision',
    });
  }
  if (kind === 'shared_resource' && value.revision === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revision'],
      message: 'Shared Saved Secret references require their exact revision',
    });
  }
}));
export type SavedSecretReferenceV1 = Readonly<z.infer<typeof SavedSecretReferenceV1Schema>>;

export const SecretReferenceOverlayV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  bindings: z.record(SecretRequirementNameSchema, SavedSecretReferenceV1Schema),
}).strict().superRefine((value, ctx) => {
  const names = Object.keys(value.bindings).filter(
    (name) => Object.prototype.hasOwnProperty.call(value.bindings, name),
  );
  if (names.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bindings'],
      message: 'Omit the overlay instead of sending an empty one',
    });
  }
}));
export type SecretReferenceOverlayV1 = Readonly<z.infer<typeof SecretReferenceOverlayV1Schema>>;

/** Deterministic own-key projection; never reads an inherited prototype key. */
export function listSecretReferenceOverlayV1BindingNames(
  overlay: SecretReferenceOverlayV1,
): readonly string[] {
  return Object.freeze(Object.keys(overlay.bindings)
    .filter((name) => Object.prototype.hasOwnProperty.call(overlay.bindings, name))
    .sort());
}

export function readSecretReferenceOverlayV1Reference(
  overlay: SecretReferenceOverlayV1,
  requirementName: string,
): SavedSecretReferenceV1 | null {
  return Object.prototype.hasOwnProperty.call(overlay.bindings, requirementName)
    ? overlay.bindings[requirementName] ?? null
    : null;
}
