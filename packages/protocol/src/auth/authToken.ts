import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

/**
 * Closed credential kinds stamped into every newly-issued signed auth token.
 * Keep this union deliberately finite: a new kind must receive an explicit
 * route-admission decision before it can authorize anything.
 */
export const AuthTokenKindSchema = lazyZodSchema(() => z.enum([
  'account',
  'account_directory',
  'terminal',
  'api_token',
  'ephemeral_session_runner',
]));
export type AuthTokenKind = z.infer<typeof AuthTokenKindSchema>;

/** Server-verified authority carried by the signed token provenance marker. */
export const AuthTokenAuthoritySchema = lazyZodSchema(() => z.enum([
  'present_user',
  'account_automation',
  'session_runtime',
]));
export type AuthTokenAuthority = z.infer<typeof AuthTokenAuthoritySchema>;

const AuthTokenEvidenceString = z.string().trim().min(1).max(512);

/**
 * A server-produced authentication fact attached to one ordinary credential.
 * It identifies the exact method or provider identity that authenticated the
 * credential; it carries no Team role, grant, profile, token, or client input.
 */
export const AuthTokenAuthenticationEvidenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('home_method'),
    methodId: AuthTokenEvidenceString,
  }).strict(),
  z.object({
    kind: z.literal('provider'),
    providerId: AuthTokenEvidenceString,
    identityId: AuthTokenEvidenceString,
    runtimeFingerprint: AuthTokenEvidenceString,
    teamConnectionId: AuthTokenEvidenceString.optional(),
  }).strict(),
]));
export type AuthTokenAuthenticationEvidenceV1 = z.infer<typeof AuthTokenAuthenticationEvidenceV1Schema>;

export const AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS = 32;

/** Canonical identity key shared by strict decoding and server-side merge/dedup. */
export function authTokenAuthenticationEvidenceIdentityV1(value: AuthTokenAuthenticationEvidenceV1): string {
  return value.kind === 'home_method'
    ? `home_method:${value.methodId.toLowerCase()}`
    : `provider:${value.providerId.toLowerCase()}:${value.identityId}:${value.teamConnectionId ?? ''}:${value.runtimeFingerprint}`;
}

const AuthTokenAuthenticationEvidenceSetV1Schema = lazyZodSchema(() => z.array(AuthTokenAuthenticationEvidenceV1Schema)
  .min(1)
  .max(AUTH_TOKEN_AUTHENTICATION_EVIDENCE_MAX_ITEMS)
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const evidence of value) {
      const key = authTokenAuthenticationEvidenceIdentityV1(evidence);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'authentication evidence must be deduplicated' });
      seen.add(key);
    }
  }));

/** Closed persisted snapshot used when an existing unattended credential is explicitly authorized. */
export const AuthTokenAuthenticationEvidenceSnapshotV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  evidence: AuthTokenAuthenticationEvidenceSetV1Schema,
}).strict());
export type AuthTokenAuthenticationEvidenceSnapshotV1 = z.infer<
  typeof AuthTokenAuthenticationEvidenceSnapshotV1Schema
>;
export const StoredAuthTokenAuthenticationEvidenceSnapshotV1Schema = createStoredReadSchema(AuthTokenAuthenticationEvidenceSnapshotV1Schema);

/**
 * The one canonical kind→authority mapping. Every mint and every
 * verification path consumes this owner; a kind carried with any other
 * authority is not a valid credential.
 */
export const AUTH_TOKEN_KIND_AUTHORITIES: Readonly<Record<AuthTokenKind, AuthTokenAuthority>> = Object.freeze({
  account: 'present_user',
  account_directory: 'present_user',
  terminal: 'account_automation',
  api_token: 'account_automation',
  ephemeral_session_runner: 'session_runtime',
});

/**
 * Top-level, signed provenance. This schema is intentionally strict so a
 * missing, future, or expanded marker cannot be silently interpreted as a
 * full Account credential, and so a kind can never travel with a
 * non-canonical authority.
 */
export const AuthTokenProvenanceSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: AuthTokenKindSchema,
  authority: AuthTokenAuthoritySchema,
}).strict().superRefine((value, ctx) => {
  if (AUTH_TOKEN_KIND_AUTHORITIES[value.kind] !== value.authority) {
    ctx.addIssue({
      code: 'custom',
      path: ['authority'],
      message: `authority "${value.authority}" is not canonical for token kind "${value.kind}"`,
    });
  }
}));
export type AuthTokenProvenance = z.infer<typeof AuthTokenProvenanceSchema>;

/** Current additive provenance marker for credentials with authentication facts. */
export const AuthTokenProvenanceV2Schema = lazyZodSchema(() => z.object({
  v: z.literal(2),
  kind: AuthTokenKindSchema,
  authority: AuthTokenAuthoritySchema,
  evidence: AuthTokenAuthenticationEvidenceSetV1Schema,
}).strict().superRefine((value, ctx) => {
  if (AUTH_TOKEN_KIND_AUTHORITIES[value.kind] !== value.authority) {
    ctx.addIssue({
      code: 'custom',
      path: ['authority'],
      message: `authority "${value.authority}" is not canonical for token kind "${value.kind}"`,
    });
  }
}));
export type AuthTokenProvenanceV2 = z.infer<typeof AuthTokenProvenanceV2Schema>;

export const AuthTokenProvenanceAnySchema = lazyZodSchema(() => z.union([
  AuthTokenProvenanceSchema,
  AuthTokenProvenanceV2Schema,
]));
export type AuthTokenProvenanceAny = z.infer<typeof AuthTokenProvenanceAnySchema>;

/**
 * Read credential provenance from a decoded signed-token payload, not a PAT.
 * This does not verify its subject, epoch or signature: the caller owns those
 * checks. Legacy admission is explicit and never rescues a malformed structured
 * marker. Accept both privacy-kit's normalized extras and the released raw JWT
 * session claim so UI, CLI and server readers share the same interpretation.
 */
export function readAuthTokenProvenance(
  payload: unknown,
  options: Readonly<{ allowLegacyHome: boolean }>,
): Readonly<{ provenance: AuthTokenProvenanceAny; legacy: boolean }> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const claims = payload as Readonly<Record<string, unknown>>;
  const extras = typeof claims.extras === 'object' && claims.extras !== null && !Array.isArray(claims.extras)
    ? claims.extras as Readonly<Record<string, unknown>> : {};
  const hasTopLevelProvenance = Object.prototype.hasOwnProperty.call(claims, 'provenance');
  const hasNestedProvenance = Object.prototype.hasOwnProperty.call(extras, 'provenance');
  const marker = hasTopLevelProvenance ? claims.provenance : extras.provenance;
  if ((!hasTopLevelProvenance && !hasNestedProvenance) || typeof marker === 'string') {
    if (!options.allowLegacyHome) return null;
    const session = Object.prototype.hasOwnProperty.call(extras, 'session') ? extras.session : claims.session;
    const kind = typeof session === 'string' && session.trim() ? 'terminal' : 'account';
    return { provenance: { v: 1, kind, authority: AUTH_TOKEN_KIND_AUTHORITIES[kind] }, legacy: true };
  }
  const parsed = AuthTokenProvenanceAnySchema.safeParse(marker);
  // PATs are database-backed direct bearers, never signed session tokens.
  if (!parsed.success || parsed.data.kind === 'api_token') return null;
  return { provenance: parsed.data, legacy: false };
}
