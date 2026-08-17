import { z } from 'zod';
import { asProtocolZod } from "./actions/internalProtocolZodAdapter.js";

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  type PluginContributionIdentityV1,
} from './contributionIdentity.js';

const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/u;
const EXTENSION_PATTERN = /^\.[a-z0-9][a-z0-9._+-]*$/u;

export function normalizeOpenableContentMimeTypeV1(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!MIME_TYPE_PATTERN.test(normalized)) {
    throw new Error('Openable content MIME selectors must be exact MIME types or type wildcards.');
  }
  return normalized;
}

export function normalizeOpenableContentExactMimeTypeV1(value: string): string {
  const normalized = normalizeOpenableContentMimeTypeV1(value);
  if (normalized.endsWith('/*')) {
    throw new Error('Openable content MIME metadata must be an exact MIME type.');
  }
  return normalized;
}

export function normalizeOpenableContentExtensionV1(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!EXTENSION_PATTERN.test(normalized)) {
    throw new Error('Openable content extension selectors must begin with a dot and contain no path separators.');
  }
  return normalized;
}

function uniqueNormalizedEntries(
  values: readonly string[],
  normalize: (value: string) => string,
  label: string,
): readonly string[] {
  const entries = values.map(normalize);
  if (new Set(entries).size !== entries.length) {
    throw new Error(`Openable content ${label} selectors must not contain duplicates after normalization.`);
  }
  return Object.freeze(entries);
}

export const OpenableContentClassV1Schema = z.enum(['text', 'image', 'binary']);
export type OpenableContentClassV1 = z.infer<typeof OpenableContentClassV1Schema>;

export const OpenableContentViewerSelectorV1Schema = z.object({
  contentClasses: z.array(OpenableContentClassV1Schema).min(1).max(8),
  mimeTypes: z.array(z.string().min(1).max(256)).max(64).optional(),
  extensions: z.array(z.string().min(1).max(256)).max(64).optional(),
}).strict().transform((value, context) => {
  const contentClasses = [...new Set(value.contentClasses)];
  if (contentClasses.length !== value.contentClasses.length) {
    context.addIssue({
      code: 'custom',
      path: ['contentClasses'],
      message: 'Openable content classes must not contain duplicates.',
    });
  }
  try {
    return {
      contentClasses,
      ...(value.mimeTypes === undefined ? {} : {
        mimeTypes: uniqueNormalizedEntries(value.mimeTypes, normalizeOpenableContentMimeTypeV1, 'MIME'),
      }),
      ...(value.extensions === undefined ? {} : {
        extensions: uniqueNormalizedEntries(value.extensions, normalizeOpenableContentExtensionV1, 'extension'),
      }),
    };
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid openable content selector.',
    });
    return z.NEVER;
  }
});
export type OpenableContentViewerSelectorV1 = z.output<typeof OpenableContentViewerSelectorV1Schema>;

export const PluginOpenableContentViewerContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  /** Same-plugin direct V2 UI view which owns the viewer presentation. */
  destination: asProtocolZod(PluginContributionLocalIdSchema),
  contentClasses: z.array(OpenableContentClassV1Schema).min(1).max(8),
  mimeTypes: z.array(z.string().min(1).max(256)).max(64).optional(),
  extensions: z.array(z.string().min(1).max(256)).max(64).optional(),
}).strict().transform((value, context) => {
  const normalized = OpenableContentViewerSelectorV1Schema.safeParse({
    contentClasses: value.contentClasses,
    ...(value.mimeTypes === undefined ? {} : { mimeTypes: value.mimeTypes }),
    ...(value.extensions === undefined ? {} : { extensions: value.extensions }),
  });
  if (!normalized.success) {
    normalized.error.issues.forEach((issue) => context.addIssue({
      ...issue,
      path: issue.path === undefined ? [] : [...issue.path],
    }));
    return z.NEVER;
  }
  return { id: value.id, destination: value.destination, ...normalized.data };
});
export type PluginOpenableContentViewerContributionV1 = z.output<
  typeof PluginOpenableContentViewerContributionV1Schema
>;

/**
 * Parses a selector through the same canonicalizer used for manifest
 * contributions. Consumers must store or compare this output, never raw MIME
 * or extension spellings.
 */
export function normalizeOpenableContentViewerSelectorV1(
  input: unknown,
): OpenableContentViewerSelectorV1 {
  return OpenableContentViewerSelectorV1Schema.parse(input);
}

const OpenableContentPreferenceSelectorInputV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mime'), value: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('extension'), value: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('class'), value: OpenableContentClassV1Schema }).strict(),
]);

/**
 * The compact persisted selector vocabulary. It is deliberately separate from
 * a viewer declaration's arrays: Account preference data chooses one matching
 * key, while declarations may advertise many keys.
 */
export const OpenableContentPreferenceSelectorV1Schema = z.unknown().transform((value, context) => {
  const parsed = OpenableContentPreferenceSelectorInputV1Schema.safeParse(value);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => context.addIssue({
      ...issue,
      path: issue.path === undefined ? [] : [...issue.path],
    }));
    return z.NEVER;
  }
  try {
    switch (parsed.data.kind) {
      case 'mime':
        return { kind: 'mime' as const, value: normalizeOpenableContentMimeTypeV1(parsed.data.value) };
      case 'extension':
        return { kind: 'extension' as const, value: normalizeOpenableContentExtensionV1(parsed.data.value) };
      case 'class':
        return parsed.data;
    }
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid openable content preference selector.',
    });
    return z.NEVER;
  }
});
export type OpenableContentPreferenceSelectorV1 = z.output<
  typeof OpenableContentPreferenceSelectorV1Schema
>;

/** Parses and returns the canonical persisted selector shape. */
export function normalizeOpenableContentPreferenceSelectorV1(
  input: unknown,
): OpenableContentPreferenceSelectorV1 {
  return OpenableContentPreferenceSelectorV1Schema.parse(input);
}

/**
 * A stable compact serialization for map keys and duplicate checks. It is
 * derived only from an already-normalized selector and never encodes a file,
 * handle, path, viewer runtime state, or viewer identity.
 */
export function serializeOpenableContentPreferenceSelectorV1(input: unknown): string {
  const selector = normalizeOpenableContentPreferenceSelectorV1(input);
  return `${selector.kind}:${selector.value}`;
}

/** Parses the compact persisted key through the same normalizer. */
export function parseOpenableContentPreferenceSelectorV1(
  serialized: string,
): OpenableContentPreferenceSelectorV1 {
  if (typeof serialized !== 'string') throw new Error('Openable content preference selectors must be strings.');
  const delimiter = serialized.indexOf(':');
  if (delimiter <= 0 || delimiter === serialized.length - 1) {
    throw new Error('Openable content preference selector serialization is malformed.');
  }
  return normalizeOpenableContentPreferenceSelectorV1({
    kind: serialized.slice(0, delimiter),
    value: serialized.slice(delimiter + 1),
  });
}

/**
 * Normalizes a collection and rejects aliases that would otherwise produce two
 * persisted keys for the same semantic selector.
 */
export function normalizeOpenableContentPreferenceSelectorsV1(
  input: readonly unknown[],
): readonly OpenableContentPreferenceSelectorV1[] {
  if (!Array.isArray(input)) throw new Error('Openable content preference selectors must be an array.');
  const selectors = input.map(normalizeOpenableContentPreferenceSelectorV1);
  const keys = selectors.map(serializeOpenableContentPreferenceSelectorV1);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Openable content preference selectors must not duplicate after normalization.');
  }
  return Object.freeze(selectors);
}

export type OpenableContentMetadataV1 = Readonly<{
  contentClass: OpenableContentClassV1;
  mimeType?: string;
  extension?: string;
}>;

export type OpenableContentViewerMatchV1 = Readonly<{
  specificity: 0 | 1 | 2 | 3;
  selector: 'contentClass' | 'extension' | 'mimeWildcard' | 'mimeExact';
}>;

function normalizeMetadataMime(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const normalized = normalizeOpenableContentMimeTypeV1(value);
    return normalized.endsWith('/*') ? null : normalized;
  } catch {
    return null;
  }
}

function normalizeMetadataExtension(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return normalizeOpenableContentExtensionV1(value);
  } catch {
    return null;
  }
}

/**
 * Match a canonical viewer declaration to host-provided metadata. Exact MIME
 * selectors outrank type wildcards, which outrank extension and class-only
 * matches. Registration/install order is intentionally absent.
 */
export function matchOpenableContentViewerV1(
  viewer: PluginOpenableContentViewerContributionV1,
  metadata: OpenableContentMetadataV1,
): OpenableContentViewerMatchV1 | null {
  if (!viewer.contentClasses.includes(metadata.contentClass)) return null;
  const mimeType = normalizeMetadataMime(metadata.mimeType);
  if (mimeType !== null && viewer.mimeTypes?.includes(mimeType)) {
    return { specificity: 3, selector: 'mimeExact' };
  }
  if (mimeType !== null && viewer.mimeTypes?.includes(`${mimeType.split('/', 1)[0]}/*`)) {
    return { specificity: 2, selector: 'mimeWildcard' };
  }
  const extension = normalizeMetadataExtension(metadata.extension);
  if (extension !== null && viewer.extensions?.includes(extension)) {
    return { specificity: 1, selector: 'extension' };
  }
  if (viewer.mimeTypes !== undefined || viewer.extensions !== undefined) return null;
  return { specificity: 0, selector: 'contentClass' };
}

export type QualifiedOpenableContentViewerMatchV1 = Readonly<{
  identity: PluginContributionIdentityV1;
  match: OpenableContentViewerMatchV1;
}>;

/** Stable ordering for selector resolution: specificity, then qualified id. */
export function compareOpenableContentViewerMatchesV1(
  left: QualifiedOpenableContentViewerMatchV1,
  right: QualifiedOpenableContentViewerMatchV1,
): number {
  if (left.match.specificity !== right.match.specificity) {
    return right.match.specificity - left.match.specificity;
  }
  const plugin = left.identity.pluginId.localeCompare(right.identity.pluginId);
  if (plugin !== 0) return plugin;
  return left.identity.localId.localeCompare(right.identity.localId);
}

export const OpenableContentViewerIdentityV1Schema = PluginContributionIdentityV1Schema;
export type OpenableContentViewerIdentityV1 = PluginContributionIdentityV1;

export function parseOpenableContentViewerIdentityV1(input: unknown): PluginContributionIdentityV1 {
  return OpenableContentViewerIdentityV1Schema.parse(input);
}
