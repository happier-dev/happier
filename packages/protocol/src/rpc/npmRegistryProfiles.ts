import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const NpmRegistryProfileIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.regex(/^[a-z0-9][a-z0-9._-]*$/u)));
export const NpmRegistryProfileRevisionV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
export const NpmRegistryProfileMutationIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)));

export const NpmRegistryOriginV1Schema = lazyZodSchema(() => z.pipe(z.string().check(z.trim(), z.minLength(1)), z.transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      ctx.issues.push({ code: 'custom', message: 'Expected a credential-free HTTPS registry origin', input: ctx.value });
      return z.NEVER;
    }
    return url.origin;
  } catch {
    ctx.issues.push({ code: 'custom', message: 'Invalid registry origin', input: ctx.value });
    return z.NEVER;
  }
})));

export const NpmRegistryScopeV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.toLowerCase(), z.minLength(2), z.maxLength(214), z.regex(/^@[a-z0-9][a-z0-9._~-]*$/u)));

export const NpmRegistryProfileInputV1Schema = lazyZodSchema(() => z.strictObject({
  displayName: z.string().check(z.trim(), z.minLength(1)),
  origin: NpmRegistryOriginV1Schema,
  scopes: z._default(z.array(NpmRegistryScopeV1Schema), []),
  useAsDefault: z._default(z.boolean(), false),
  allowPrivateNetwork: z._default(z.boolean(), false),
}).check(z.superRefine((value, ctx) => {
  if (new Set(value.scopes).size !== value.scopes.length) {
    ctx.addIssue({ code: 'custom', path: ['scopes'], message: 'Duplicate registry scope' });
  }
})));

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

export const NpmRegistryProfileViewV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(NpmRegistryProfileInputV1Schema, {
  profileId: NpmRegistryProfileIdV1Schema,
  hasCredentials: z.boolean(),
  authenticationState: NpmRegistryAuthenticationStateV1Schema,
  availability: NpmRegistryAvailabilityV1Schema,
  lastSuccessfulCheckAtMs: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
  updatedAtMs: z.number().check(z.int(), z.nonnegative()),
})));

export const NpmRegistryPausedSourceV1Schema = lazyZodSchema(() => z.strictObject({
  origin: NpmRegistryOriginV1Schema,
  reason: z.enum(['credentials_missing', 'authentication_failed', 'profile_removed', 'offline']),
  updatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));

export const DaemonNpmRegistryProfileSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
  revision: NpmRegistryProfileRevisionV1Schema,
  profiles: z.array(NpmRegistryProfileViewV1Schema),
  pausedSources: z.array(NpmRegistryPausedSourceV1Schema),
}));
export type DaemonNpmRegistryProfileSnapshotV1 = z.infer<typeof DaemonNpmRegistryProfileSnapshotV1Schema>;

const MutationBaseSchema = lazyZodSchema(() => z.object({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  expectedRevision: NpmRegistryProfileRevisionV1Schema,
  mutationId: NpmRegistryProfileMutationIdV1Schema,
}));

/** Public sign-in intent; credentials and the browser completion URL stay on the Machine. */
export const NpmRegistryProfileLoginMethodV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('machine'), projectDir: z.optional(z.string().check(z.trim(), z.minLength(1))) }),
  z.strictObject({ kind: z.literal('browser'), step: z.literal('start') }),
  z.strictObject({ kind: z.literal('browser'), step: z.enum(['complete', 'cancel']), loginId: z.string().check(z.minLength(1)) }),
]));
export type NpmRegistryProfileLoginMethodV1 = z.infer<typeof NpmRegistryProfileLoginMethodV1Schema>;

export const DaemonNpmRegistryProfileMutationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('action', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MutationBaseSchema, {
    action: z.literal('add'),
    profileId: NpmRegistryProfileIdV1Schema,
    profile: NpmRegistryProfileInputV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MutationBaseSchema, {
    action: z.literal('update'),
    profileId: NpmRegistryProfileIdV1Schema,
    profile: NpmRegistryProfileInputV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MutationBaseSchema, {
    action: z.literal('login'),
    profileId: NpmRegistryProfileIdV1Schema,
    credential: z.union([NpmRegistryProfileLoginMethodV1Schema,
      z.strictObject({ kind: z.literal('bearer_token'), secret: z.string().check(z.minLength(1)) }),
    ]),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MutationBaseSchema, {
    action: z.literal('logout'),
    profileId: NpmRegistryProfileIdV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MutationBaseSchema, {
    action: z.literal('remove'),
    profileId: NpmRegistryProfileIdV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MutationBaseSchema, {
    action: z.literal('test'),
    profileId: NpmRegistryProfileIdV1Schema,
  })),
]));
export type DaemonNpmRegistryProfileMutationRequestV1 = z.infer<typeof DaemonNpmRegistryProfileMutationRequestV1Schema>;

const NpmRegistryProfileRpcErrorV1Schema = lazyZodSchema(() => z.strictObject({
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
    'web_login_unsupported',
  ]),
  retryable: z.boolean(),
  currentRevision: z.optional(NpmRegistryProfileRevisionV1Schema),
}));

export const DaemonNpmRegistryProfileMutationResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('success'), snapshot: DaemonNpmRegistryProfileSnapshotV1Schema }),
  z.strictObject({ status: z.literal('browser_login_required'), loginId: z.string().check(z.minLength(1)), loginUrl: z.string().check(z.url()) }),
  z.strictObject({ status: z.literal('cancelled') }),
  NpmRegistryProfileRpcErrorV1Schema,
]));
export type DaemonNpmRegistryProfileMutationResponseV1 = z.infer<typeof DaemonNpmRegistryProfileMutationResponseV1Schema>;

export const DaemonNpmRegistryProfilesGetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
}));

export const DaemonNpmRegistryProfilesGetResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('success'), snapshot: DaemonNpmRegistryProfileSnapshotV1Schema }),
  NpmRegistryProfileRpcErrorV1Schema,
]));
export type DaemonNpmRegistryProfilesGetResponseV1 = z.infer<typeof DaemonNpmRegistryProfilesGetResponseV1Schema>;
