import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryPackageContentSourceV1Schema } from './registrySourcesV1.js';

/** Pinned references stay independent of registry listing/manifest projections. */
export const RegistryGitTreeRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('gitTree'), repo: z.string().check(z.minLength(1)), path: z.string(),
  commit: z.string().check(z.minLength(1)), treeSha: z.string().check(z.minLength(1)),
}));
export const WellKnownSkillRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('wellKnown'),
  indexUrl: z.string().check(z.url(), z.refine(raw => { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password; })),
  name: z.string().check(z.regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)),
  /** Materialized bundle digest, including every path, byte and executable bit. */
  digest: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/)),
  /** Present only when the publisher's artifact digest was verified. */
  publishedDigest: z.optional(z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/))),
}));
export type WellKnownSkillRefV1 = z.infer<typeof WellKnownSkillRefV1Schema>;
export const RegistrySkillContentRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [RegistryGitTreeRefV1Schema, WellKnownSkillRefV1Schema]));
export type RegistrySkillContentRefV1 = z.infer<typeof RegistrySkillContentRefV1Schema>;
export const RegistryPackageContentRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('packageContent'), ...RegistryPackageContentSourceV1Schema.shape,
  digest: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)),
}));
export const RegistryRemoteContentRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  RegistryGitTreeRefV1Schema,
  z.strictObject({ kind: z.literal('version'), version: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('content'), digest: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)) }),
  WellKnownSkillRefV1Schema,
]));
export const RegistryContentRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ...RegistryRemoteContentRefV1Schema.def.options, RegistryPackageContentRefV1Schema,
]));
export type RegistryContentRefV1 = z.infer<typeof RegistryContentRefV1Schema>;
export const RegistryItemPointerV1Schema = lazyZodSchema(() => z.strictObject({ sourceId: z.string().check(z.minLength(1)),
  itemId: z.string(), version: z.string().check(z.minLength(1)) }));
export type RegistryItemPointerV1 = z.infer<typeof RegistryItemPointerV1Schema>;
