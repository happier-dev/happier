import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const NpmRegistryProfileIdV1Schema = lazyZodSchema(() => z.string().trim().min(1)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u));

export const NpmRegistryOriginV1Schema = lazyZodSchema(() => z.string().trim().min(1).transform((value, ctx) => {
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
}));

export const NpmRegistryScopeV1Schema = lazyZodSchema(() => z.string().trim().toLowerCase().min(2).max(214)
  .regex(/^@[a-z0-9][a-z0-9._~-]*$/u));

export const NpmRegistryProfileInputV1Schema = lazyZodSchema(() => z.object({
  displayName: z.string().trim().min(1),
  origin: NpmRegistryOriginV1Schema,
  scopes: z.array(NpmRegistryScopeV1Schema).default([]),
  useAsDefault: z.boolean().default(false),
  allowPrivateNetwork: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.scopes).size !== value.scopes.length) {
    ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'Duplicate registry scope' });
  }
}));

export const NpmRegistryAuthenticationStateV1Schema = lazyZodSchema(() => z.enum([
  'configured',
  'missing',
]));

export const NpmRegistryAvailabilityV1Schema = lazyZodSchema(() => z.enum([
  'unknown',
  'available',
  'sign_in_required',
  'offline',
]));

export const NpmRegistryProfileViewV1Schema = lazyZodSchema(() => NpmRegistryProfileInputV1Schema.extend({
  profileId: NpmRegistryProfileIdV1Schema,
  hasCredentials: z.boolean(),
  authenticationState: NpmRegistryAuthenticationStateV1Schema,
  availability: NpmRegistryAvailabilityV1Schema,
  lastSuccessfulCheckAtMs: z.number().int().nonnegative().nullable().default(null),
  updatedAtMs: z.number().int().nonnegative(),
}).strict());

export const NpmRegistryPausedSourceV1Schema = lazyZodSchema(() => z.object({
  origin: NpmRegistryOriginV1Schema,
  reason: z.enum(['credentials_missing', 'authentication_failed', 'profile_removed', 'offline']),
  updatedAtMs: z.number().int().nonnegative(),
}).strict());

export const DaemonNpmRegistryProfileSnapshotV1Schema = lazyZodSchema(() => z.object({
  protocolVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z.array(NpmRegistryProfileViewV1Schema),
  pausedSources: z.array(NpmRegistryPausedSourceV1Schema),
}).strict());
export type DaemonNpmRegistryProfileSnapshotV1 = z.infer<typeof DaemonNpmRegistryProfileSnapshotV1Schema>;

const MutationBaseSchema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  mutationId: z.string().trim().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}));

export const DaemonNpmRegistryProfileMutationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
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
      secret: z.string().min(1),
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
]));
export type DaemonNpmRegistryProfileMutationRequestV1 = z.infer<typeof DaemonNpmRegistryProfileMutationRequestV1Schema>;

const NpmRegistryProfileRpcErrorV1Schema = lazyZodSchema(() => z.object({
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
}).strict());

export const DaemonNpmRegistryProfileMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('success'), snapshot: DaemonNpmRegistryProfileSnapshotV1Schema }).strict(),
  NpmRegistryProfileRpcErrorV1Schema,
]));
export type DaemonNpmRegistryProfileMutationResponseV1 = z.infer<typeof DaemonNpmRegistryProfileMutationResponseV1Schema>;

export const DaemonNpmRegistryProfilesGetRequestV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
}).strict());

export const DaemonNpmRegistryProfilesGetResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('success'), snapshot: DaemonNpmRegistryProfileSnapshotV1Schema }).strict(),
  NpmRegistryProfileRpcErrorV1Schema,
]));
export type DaemonNpmRegistryProfilesGetResponseV1 = z.infer<typeof DaemonNpmRegistryProfilesGetResponseV1Schema>;
