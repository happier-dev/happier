import { z } from 'zod';

const PROFILE_LIMIT = 64;
const SCOPE_LIMIT = 64;

export const NpmRegistryProfileIdV1Schema = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

export const NpmRegistryOriginV1Schema = z.string().trim().min(1).max(2048).transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'Expected a credential-free HTTPS registry origin' });
      return z.NEVER;
    }
    return url.origin;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid registry origin' });
    return z.NEVER;
  }
});

export const NpmRegistryScopeV1Schema = z.string().trim().toLowerCase().min(2).max(214)
  .regex(/^@[a-z0-9][a-z0-9._~-]*$/u);

export const NpmRegistryProfileInputV1Schema = z.object({
  displayName: z.string().trim().min(1).max(128),
  origin: NpmRegistryOriginV1Schema,
  scopes: z.array(NpmRegistryScopeV1Schema).max(SCOPE_LIMIT).default([]),
  useAsDefault: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.scopes).size !== value.scopes.length) {
    ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'Duplicate registry scope' });
  }
});

export const NpmRegistryAuthenticationStateV1Schema = z.enum([
  'configured',
  'missing',
]);

export const NpmRegistryAvailabilityV1Schema = z.enum([
  'unknown',
  'available',
  'sign_in_required',
  'offline',
]);

export const NpmRegistryProfileViewV1Schema = NpmRegistryProfileInputV1Schema.extend({
  profileId: NpmRegistryProfileIdV1Schema,
  hasCredentials: z.boolean(),
  authenticationState: NpmRegistryAuthenticationStateV1Schema,
  availability: NpmRegistryAvailabilityV1Schema,
  lastSuccessfulCheckAtMs: z.number().int().nonnegative().nullable().default(null),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();

export const NpmRegistryPausedSourceV1Schema = z.object({
  origin: NpmRegistryOriginV1Schema,
  reason: z.enum(['credentials_missing', 'authentication_failed', 'profile_removed', 'offline']),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();

export const DaemonNpmRegistryProfileSnapshotV1Schema = z.object({
  protocolVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z.array(NpmRegistryProfileViewV1Schema).max(PROFILE_LIMIT),
  pausedSources: z.array(NpmRegistryPausedSourceV1Schema).max(PROFILE_LIMIT),
}).strict();
export type DaemonNpmRegistryProfileSnapshotV1 = z.infer<typeof DaemonNpmRegistryProfileSnapshotV1Schema>;

const MutationBaseSchema = z.object({
  machineId: z.string().trim().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(),
  mutationId: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
});

export const DaemonNpmRegistryProfileMutationRequestV1Schema = z.discriminatedUnion('action', [
  MutationBaseSchema.extend({
    action: z.literal('add'),
    profileId: NpmRegistryProfileIdV1Schema,
    profile: NpmRegistryProfileInputV1Schema,
  }).strict(),
  MutationBaseSchema.extend({
    action: z.literal('update'),
    profileId: NpmRegistryProfileIdV1Schema,
    profile: NpmRegistryProfileInputV1Schema,
  }).strict(),
  MutationBaseSchema.extend({
    action: z.literal('login'),
    profileId: NpmRegistryProfileIdV1Schema,
    credential: z.object({
      kind: z.literal('bearer_token'),
      secret: z.string().min(1).max(8192),
    }).strict(),
  }).strict(),
  MutationBaseSchema.extend({
    action: z.literal('logout'),
    profileId: NpmRegistryProfileIdV1Schema,
  }).strict(),
  MutationBaseSchema.extend({
    action: z.literal('remove'),
    profileId: NpmRegistryProfileIdV1Schema,
  }).strict(),
  MutationBaseSchema.extend({
    action: z.literal('test'),
    profileId: NpmRegistryProfileIdV1Schema,
  }).strict(),
]);
export type DaemonNpmRegistryProfileMutationRequestV1 = z.infer<typeof DaemonNpmRegistryProfileMutationRequestV1Schema>;

const NpmRegistryProfileRpcErrorV1Schema = z.object({
  status: z.literal('error'),
  code: z.enum([
    'invalid_request',
    'not_found',
    'revision_conflict',
    'profile_conflict',
    'authentication_required',
    'authentication_failed',
    'offline',
    'unavailable',
  ]),
  retryable: z.boolean(),
  currentRevision: z.number().int().nonnegative().optional(),
}).strict();

export const DaemonNpmRegistryProfileMutationResponseV1Schema = z.union([
  z.object({ status: z.literal('success'), snapshot: DaemonNpmRegistryProfileSnapshotV1Schema }).strict(),
  NpmRegistryProfileRpcErrorV1Schema,
]);
export type DaemonNpmRegistryProfileMutationResponseV1 = z.infer<typeof DaemonNpmRegistryProfileMutationResponseV1Schema>;

export const DaemonNpmRegistryProfilesGetRequestV1Schema = z.object({
  machineId: z.string().trim().min(1).max(256),
}).strict();

export const DaemonNpmRegistryProfilesGetResponseV1Schema = z.union([
  z.object({ status: z.literal('success'), snapshot: DaemonNpmRegistryProfileSnapshotV1Schema }).strict(),
  NpmRegistryProfileRpcErrorV1Schema,
]);
export type DaemonNpmRegistryProfilesGetResponseV1 = z.infer<typeof DaemonNpmRegistryProfilesGetResponseV1Schema>;
