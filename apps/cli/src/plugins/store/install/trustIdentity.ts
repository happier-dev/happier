import { realpath } from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';

import { z } from 'zod';
import { normalizeMarketplaceSourceUrlV1, PluginIdSchema } from '@happier-dev/protocol';
import { NpmRegistryProfileIdV1Schema } from '@happier-dev/protocol/rpc';

import { normalizeNpmPackageName, normalizeNpmRegistryOrigin } from '@/plugins/distribution/npm/normalize';
import {
  canonicalAbsolutePathsEqual,
  expandHomeDirPath,
} from '@/utils/path/expandHomeDirPath';

function isCanonicalBase64(value: string): boolean {
  try {
    if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

export const AlgorithmQualifiedIntegritySchema = z.string().min(3).max(1024).superRefine((value, context) => {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  const expectedBytes = match?.[1] === 'sha256' ? 32 : match?.[1] === 'sha384' ? 48 : match?.[1] === 'sha512' ? 64 : 0;
  if (
    value !== value.trim()
    || !match
    || !isCanonicalBase64(match[2]!)
    || Buffer.from(match[2]!, 'base64').byteLength !== expectedBytes
  ) {
    context.addIssue({ code: 'custom', message: 'Expected canonical algorithm-qualified plugin archive integrity' });
  }
});

const CanonicalRemoteArchiveUrlSchema = z.string().max(2048).url().superRefine((value, context) => {
  const url = new URL(value);
  if (value !== value.trim() || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.toString() !== value) {
    context.addIssue({ code: 'custom', message: 'Expected a canonical HTTP(S) archive URL without credentials or fragment' });
  }
});

const CanonicalNpmRegistryOriginSchema = z.string().superRefine((value, context) => {
  try {
    if (normalizeNpmRegistryOrigin(value) !== value) throw new Error();
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a canonical npm registry origin' });
  }
});

const CanonicalNpmPackageNameSchema = z.string().superRefine((value, context) => {
  try {
    if (normalizeNpmPackageName(value) !== value) throw new Error();
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a canonical npm package name' });
  }
});

const CanonicalNpmRegistryProfileIdSchema = z.string().superRefine((value, context) => {
  const parsed = NpmRegistryProfileIdV1Schema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    context.addIssue({ code: 'custom', message: 'Expected a canonical npm registry profile id' });
  }
});

const CanonicalMarketplaceSourceIdSchema = z.string().trim().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const CanonicalMarketplaceSourceUrlSchema = z.string().superRefine((value, context) => {
  try {
    if (normalizeMarketplaceSourceUrlV1(value) !== value) throw new Error();
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a canonical curated marketplace source URL' });
  }
});

function isCanonicalAbsolutePath(value: string): boolean {
  if (!value || Buffer.byteLength(value, 'utf8') > 32_768 || /[\0\r\n]/u.test(value)) return false;
  if (posix.isAbsolute(value)) {
    return posix.normalize(value) === value && (value === posix.parse(value).root || !value.endsWith('/'));
  }
  if (win32.isAbsolute(value)) {
    return !value.includes('/')
      && win32.normalize(value) === value
      && (value === win32.parse(value).root || !value.endsWith('\\'));
  }
  return false;
}

const CanonicalAbsolutePathSchema = z.string().refine(isCanonicalAbsolutePath, 'Expected a canonical absolute path');

const CanonicalPluginIdSchema = z.string().superRefine((value, context) => {
  const parsed = PluginIdSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) {
    context.addIssue({ code: 'custom', message: 'Expected a canonical plugin id' });
  }
});

export type PluginDistributionIdentity =
  | Readonly<{ kind: 'npm'; registryOrigin: string; registryProfileId?: string; packageName: string }>
  | Readonly<{ kind: 'localPath'; canonicalPath: string }>
  | Readonly<{
    kind: 'archive';
    source: Readonly<{ kind: 'localFile'; canonicalPath: string }> | Readonly<{ kind: 'remoteUrl'; canonicalUrl: string }>;
    integrity: string;
  }>;

export const PluginDistributionIdentitySchema: z.ZodType<PluginDistributionIdentity> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('npm'),
    registryOrigin: CanonicalNpmRegistryOriginSchema,
    registryProfileId: CanonicalNpmRegistryProfileIdSchema.optional(),
    packageName: CanonicalNpmPackageNameSchema,
  }).strict(),
  z.object({
    kind: z.literal('localPath'),
    canonicalPath: CanonicalAbsolutePathSchema,
  }).strict(),
  z.object({
    kind: z.literal('archive'),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('localFile'), canonicalPath: CanonicalAbsolutePathSchema }).strict(),
      z.object({ kind: z.literal('remoteUrl'), canonicalUrl: CanonicalRemoteArchiveUrlSchema }).strict(),
    ]),
    integrity: AlgorithmQualifiedIntegritySchema,
  }).strict(),
]);

export type PluginTrustRecord = Readonly<{
  pluginId: string;
  distribution: PluginDistributionIdentity;
  state: 'trusted';
  approvedAtMs: number;
}>;

export const PluginTrustRecordSchema: z.ZodType<PluginTrustRecord> = z.object({
  pluginId: CanonicalPluginIdSchema,
  distribution: PluginDistributionIdentitySchema,
  state: z.literal('trusted'),
  approvedAtMs: z.number().int().nonnegative().refine(Number.isSafeInteger, 'Expected a safe trust approval timestamp'),
}).strict();

/**
 * What an installed plugin's record permits when an update is **requested**.
 *
 * Happier has no update scheduler. Nothing here runs on a timer, at startup or
 * in the background: every policy below is read only while
 * `resolveInstalledPluginUpdate` answers an explicit `{ kind: 'update' }`
 * request from `happier install plugin update` or the Plugins settings screen.
 *
 * - `pinned` — the request is refused (`plugin_update_pinned`). The installation
 *   stays where the user put it until they change this policy.
 * - `manual` — the request proceeds, and the newest compatible candidate is
 *   staged and presented to a present user, who decides it like any install.
 * - `automatic` — the request proceeds and may be admitted *without a new
 *   present-user review*, which is the whole of what "automatic" names. It is
 *   authorized only for an npm channel whose reviewed curated source binding is
 *   still current and unchanged, whose trust record still matches the candidate
 *   distribution, and whose manifest change is not review-sensitive; it also
 *   requires published compatibility metadata, so an unevaluatable candidate is
 *   ineligible rather than silently taken. Any of those failing falls back to
 *   the present-user review, never to a silent upgrade.
 */
export const PluginUpdatePolicySchema = z.enum(['automatic', 'manual', 'pinned']);
export type PluginUpdatePolicy = z.infer<typeof PluginUpdatePolicySchema>;

/**
 * The only durable authority for a curated automatic update. Publisher data is
 * review presentation only and intentionally does not participate here.
 */
export const PluginCuratedUpdateSourceBindingSchema = z.object({
  id: CanonicalMarketplaceSourceIdSchema,
  sourceUrl: CanonicalMarketplaceSourceUrlSchema,
  registryProfileId: CanonicalNpmRegistryProfileIdSchema.optional(),
}).strict();
export type PluginCuratedUpdateSourceBinding = z.infer<typeof PluginCuratedUpdateSourceBindingSchema>;

export function createPluginCuratedUpdateSourceBinding(input: Readonly<{
  id: string;
  sourceUrl: string;
  registryProfileId?: string;
}>): PluginCuratedUpdateSourceBinding {
  return PluginCuratedUpdateSourceBindingSchema.parse({
    id: input.id,
    sourceUrl: normalizeMarketplaceSourceUrlV1(input.sourceUrl),
    ...(input.registryProfileId ? { registryProfileId: input.registryProfileId } : {}),
  });
}

export function createNpmPluginDistributionIdentity(params: Readonly<{
  registryOrigin: string;
  registryProfileId?: string;
  packageName: string;
}>): PluginDistributionIdentity {
  return PluginDistributionIdentitySchema.parse({
    kind: 'npm',
    registryOrigin: normalizeNpmRegistryOrigin(params.registryOrigin),
    ...(params.registryProfileId ? { registryProfileId: params.registryProfileId } : {}),
    packageName: normalizeNpmPackageName(params.packageName),
  });
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  return await realpath(resolve(expandHomeDirPath(path.trim())));
}

export async function createLocalPathPluginDistributionIdentity(path: string): Promise<PluginDistributionIdentity> {
  return PluginDistributionIdentitySchema.parse({
    kind: 'localPath',
    canonicalPath: await canonicalizeExistingPath(path),
  });
}

function canonicalizeRemoteArchiveUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Invalid remote plugin archive source URL');
  }
  const durableSelectors = [...url.searchParams.entries()].filter(
    ([key, selector]) => key === 'download' && selector === '1',
  );
  url.search = '';
  for (const [key, selector] of durableSelectors) {
    url.searchParams.append(key, selector);
  }
  return url.toString();
}

export async function createArchivePluginDistributionIdentity(params: Readonly<{
  source: Readonly<{ kind: 'localFile'; path: string }> | Readonly<{ kind: 'remoteUrl'; url: string }>;
  integrity: string;
}>): Promise<PluginDistributionIdentity> {
  const source = params.source.kind === 'localFile'
    ? { kind: 'localFile' as const, canonicalPath: await canonicalizeExistingPath(params.source.path) }
    : { kind: 'remoteUrl' as const, canonicalUrl: canonicalizeRemoteArchiveUrl(params.source.url) };
  return PluginDistributionIdentitySchema.parse({
    kind: 'archive',
    source,
    integrity: params.integrity.trim(),
  });
}

export function createPluginTrustRecord(params: Readonly<{
  pluginId: string;
  distribution: PluginDistributionIdentity;
  approvedAtMs: number;
}>): PluginTrustRecord {
  return PluginTrustRecordSchema.parse({
    ...params,
    pluginId: PluginIdSchema.parse(params.pluginId),
    state: 'trusted',
  });
}

export function pluginDistributionIdentitiesEqual(
  left: PluginDistributionIdentity,
  right: PluginDistributionIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'npm') {
    return right.kind === 'npm'
      && left.registryOrigin === right.registryOrigin
      && (left.registryProfileId ?? null) === (right.registryProfileId ?? null)
      && left.packageName === right.packageName;
  }
  if (left.kind === 'localPath') {
    return right.kind === 'localPath' && canonicalAbsolutePathsEqual(left.canonicalPath, right.canonicalPath);
  }
  if (right.kind !== 'archive' || left.integrity !== right.integrity || left.source.kind !== right.source.kind) {
    return false;
  }
  return left.source.kind === 'localFile'
    ? right.source.kind === 'localFile' && canonicalAbsolutePathsEqual(left.source.canonicalPath, right.source.canonicalPath)
    : right.source.kind === 'remoteUrl' && left.source.canonicalUrl === right.source.canonicalUrl;
}

/**
 * Whether two reviewed distributions belong to the same rollback lineage.
 * Archive integrity is deliberately excluded: replacement bytes require a new
 * trust decision, but the previously reviewed bytes remain an explicit
 * rollback target when the canonical archive source itself did not change.
 */
export function pluginDistributionRollbackLineagesEqual(
  left: PluginDistributionIdentity,
  right: PluginDistributionIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'npm') {
    return right.kind === 'npm'
      && left.registryOrigin === right.registryOrigin
      && (left.registryProfileId ?? null) === (right.registryProfileId ?? null)
      && left.packageName === right.packageName;
  }
  if (left.kind === 'localPath') {
    return right.kind === 'localPath' && canonicalAbsolutePathsEqual(left.canonicalPath, right.canonicalPath);
  }
  if (right.kind !== 'archive' || left.source.kind !== right.source.kind) return false;
  return left.source.kind === 'localFile'
    ? right.source.kind === 'localFile' && canonicalAbsolutePathsEqual(left.source.canonicalPath, right.source.canonicalPath)
    : right.source.kind === 'remoteUrl' && left.source.canonicalUrl === right.source.canonicalUrl;
}

export function isPluginTrustRecordAuthorized(
  trust: unknown,
  candidate: Readonly<{
    pluginId: string;
    distribution: PluginDistributionIdentity;
    realm?: 'daemon' | 'reactNative' | 'reactNativeWeb' | 'hostedWeb' | 'declarative';
  }>,
): boolean {
  const parsedTrust = PluginTrustRecordSchema.safeParse(trust);
  const parsedDistribution = PluginDistributionIdentitySchema.safeParse(candidate.distribution);
  const parsedCandidatePluginId = PluginIdSchema.safeParse(candidate.pluginId);
  return parsedTrust.success
    && parsedDistribution.success
    && parsedCandidatePluginId.success
    && parsedCandidatePluginId.data === candidate.pluginId
    && parsedTrust.data.pluginId === candidate.pluginId
    && pluginDistributionIdentitiesEqual(parsedTrust.data.distribution, parsedDistribution.data);
}
