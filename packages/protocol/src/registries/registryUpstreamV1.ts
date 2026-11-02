import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RegistryContentRefV1Schema, type RegistryContentRefV1 } from './registryItemsV1.js';
import { RegistrySourceStatusV1Schema, type RegistrySourceStatusV1 } from './registryListV1.js';
import { RegistryKindV1Schema, type RegistryKindV1 } from './registrySourcesV1.js';

/** Persisted item state; format readers consume this without importing the checker. */
export const RegistryUpstreamV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['current', 'update_available', 'removed_from_source']),
  latest: z.optional(RegistryContentRefV1Schema),
}));
export type RegistryUpstreamV1 = z.infer<typeof RegistryUpstreamV1Schema>;

const RegistrySourceFailureV1Schema = lazyZodSchema(() => {
  // The source-status owner declares success first and a nonempty failure tail.
  const [, firstFailure, ...remainingFailures] = RegistrySourceStatusV1Schema._zod.def.options;
  return z.discriminatedUnion('state', [firstFailure, ...remainingFailures]);
});

/** Failed checks are session observations, never stored upstream state. */
export const RegistryUpstreamCheckV1Schema = lazyZodSchema(() => z.union([
  RegistryUpstreamV1Schema,
  z.strictObject({ state: z.literal('unchecked'), reason: RegistrySourceFailureV1Schema }),
]));
export type RegistryUpstreamCheckV1 = RegistryUpstreamV1 | Readonly<{
  state: 'unchecked'; reason: Exclude<RegistrySourceStatusV1, { state: 'ok' }>;
}>;
export const RegistryUpdateCheckResultV1Schema = lazyZodSchema(() => z.strictObject({
  checkedAt: z.number().check(z.int(), z.nonnegative()),
  results: z.array(z.strictObject({ kind: RegistryKindV1Schema, key: z.string().check(z.minLength(1)), upstream: RegistryUpstreamCheckV1Schema })),
}));
export type RegistryUpdateCheckResultV1 = Readonly<{
  checkedAt: number;
  results: readonly Readonly<{ kind: RegistryKindV1; key: string; upstream: RegistryUpstreamCheckV1 }>[];
}>;

/** Stored observations compare the full latest pointer, including commit custody. */
export function registryUpstreamEqualV1(left: RegistryUpstreamV1 | undefined, right: RegistryUpstreamV1 | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.state !== right.state) return false;
  const a = left.latest, b = right.latest;
  if (!a || !b) return a === b;
  return a.kind === 'version' && b.kind === 'version' ? a.version === b.version
    : a.kind === 'wellKnown' && b.kind === 'wellKnown' ? a.indexUrl === b.indexUrl && a.name === b.name && a.digest === b.digest && a.publishedDigest === b.publishedDigest
    : a.kind === 'gitTree' && b.kind === 'gitTree' && a.repo === b.repo && a.path === b.path
      && a.commit === b.commit && a.treeSha === b.treeSha;
}

export function compareRegistryContentRefV1(current: RegistryContentRefV1, latest: RegistryContentRefV1 | 'removed'): RegistryUpstreamV1['state'] {
  if (latest === 'removed') return 'removed_from_source';
  const equal = current.kind === 'version' && latest.kind === 'version' ? current.version === latest.version
    : current.kind === 'wellKnown' && latest.kind === 'wellKnown' ? current.indexUrl === latest.indexUrl && current.name === latest.name && current.digest === latest.digest && current.publishedDigest === latest.publishedDigest
    : current.kind === 'gitTree' && latest.kind === 'gitTree'
      && current.repo === latest.repo && current.path === latest.path && current.treeSha === latest.treeSha;
  return equal ? 'current' : 'update_available';
}

export function registryContentRefEqualV1(a: RegistryContentRefV1, b: RegistryContentRefV1): boolean {
  return a.kind === 'version' && b.kind === 'version' ? a.version === b.version
    : a.kind === 'content' && b.kind === 'content' ? a.digest === b.digest
    : a.kind === 'packageContent' && b.kind === 'packageContent' ? a.pluginId === b.pluginId && a.pluginVersion === b.pluginVersion
      && a.path === b.path && a.digest === b.digest
    : a.kind === 'wellKnown' && b.kind === 'wellKnown' ? a.indexUrl === b.indexUrl && a.name === b.name && a.digest === b.digest && a.publishedDigest === b.publishedDigest
    : a.kind === 'gitTree' && b.kind === 'gitTree' && a.repo === b.repo && a.path === b.path
      && a.commit === b.commit && a.treeSha === b.treeSha;
}
