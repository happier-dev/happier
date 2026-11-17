import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { mergeThemeProfileDocumentEdit, parseThemeProfileDocument, ThemeMiniatureDataSchema, type ThemeProfileDocument } from '../account/settings/themeProfiles.js';
import { ThemeImportIssueCodeSchema } from '../account/settings/themeProfileExternalThemeImportVsCode.js';
import { RegistryContentRefV1Schema } from './registryContentRefV1.js';
import { normalizeRegistrySourceUrlV1 } from './registrySourcesV1.js';

export const RegistryThemeIssueV1Schema = lazyZodSchema(() => z.union([
  z.enum(['checksum_mismatch', 'manifest_mismatch', 'invalid_package']), ThemeImportIssueCodeSchema,
]));
export type RegistryThemeIssueV1 = z.infer<typeof RegistryThemeIssueV1Schema>;

const identity = () => z.string().check(z.minLength(1));
const mode = () => ThemeMiniatureDataSchema.shape.mode;
export const RegistryThemeListingV1Schema = lazyZodSchema(() => z.strictObject({
  includes: z.array(z.strictObject({ key: identity(), label: identity(), mode: z.optional(mode()) })),
  license: z.optional(z.string()), licenseKind: z.optional(z.literal('custom')),
  licenseUrl: z.optional(RegistryThemeContentUrlV1Schema), preview: z.optional(z.array(ThemeMiniatureDataSchema)),
}));
export type RegistryThemeListingV1 = z.infer<typeof RegistryThemeListingV1Schema>;
/** The retained raw presentation is authoritative; supported projections are derived once at ingress. */
export const RegistryThemeDocumentV1Schema = lazyZodSchema(() => z.pipe(z.strictObject({
  profile: z.unknown(), raw: z.unknown(), compatibility: z.unknown(),
}), z.transform((value, ctx): ThemeProfileDocument => {
  const result = parseThemeProfileDocument(value.raw);
  if (result.ok) return result.document;
  ctx.issues.push({ code: 'custom', input: value, message: result.error });
  return z.NEVER;
})));
/** A selected face's advertised mode is its preferred appearance in the installed library. */
export const RegistryThemeFaceV1Schema = lazyZodSchema(() => z.strictObject({
  key: identity(), label: identity(), mode: mode(), document: RegistryThemeDocumentV1Schema,
}).check(z.overwrite(face => ({ ...face, document: mergeThemeProfileDocumentEdit(face.document, { assetAppearance: face.mode }) }))));
export type RegistryThemeFaceV1 = z.infer<typeof RegistryThemeFaceV1Schema>;
export const RegistryThemeContentUrlV1Schema = lazyZodSchema(() => z.string().check(z.url(), z.refine(value => {
  try { normalizeRegistrySourceUrlV1(value); return true; } catch { return false; }
})));
export const OpenVsxThemePackageV1Schema = lazyZodSchema(() => z.strictObject({ namespace: identity(), name: identity(), version: identity(),
  downloadUrl: RegistryThemeContentUrlV1Schema, checksumUrl: RegistryThemeContentUrlV1Schema, license: z.optional(z.string()) }));
export type OpenVsxThemePackageV1 = z.infer<typeof OpenVsxThemePackageV1Schema>;
export const RegistryThemePayloadV1Schema = lazyZodSchema(() => z.discriminatedUnion('state', [
  z.strictObject({ kind: z.literal('theme'), state: z.literal('listing'), version: identity(), listing: RegistryThemeListingV1Schema, acquisition: z.optional(OpenVsxThemePackageV1Schema) }),
  z.strictObject({ kind: z.literal('theme'), state: z.literal('ready'), version: identity(), listing: RegistryThemeListingV1Schema,
    themes: z.array(RegistryThemeFaceV1Schema), ref: RegistryContentRefV1Schema }).check(z.refine(value => {
      const expected = new Map(value.listing.includes.map(face => [face.key, face]));
      return (value.ref.kind !== 'version' || value.ref.version === value.version)
        && expected.size === value.listing.includes.length && value.themes.length === expected.size
        && new Set(value.themes.map(face => face.key)).size === value.themes.length
        && value.themes.every(face => { const known = expected.get(face.key);
          return known !== undefined && known.label === face.label && (known.mode === undefined || known.mode === face.mode); });
    }, 'Ready faces must identify the advertised listing and version')),
]));
export type RegistryThemePayloadV1 = z.infer<typeof RegistryThemePayloadV1Schema>;
/** Catalog indices admit identity and summary only; selected documents are parsed on read. */
export const RegistryThemeCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({ itemId: identity(), title: identity(), version: identity(),
  description: z.optional(z.string()), listing: RegistryThemeListingV1Schema, contentUrl: z.optional(RegistryThemeContentUrlV1Schema), themes: z.optional(z.array(z.unknown())),
}).check(z.refine(value => (value.contentUrl === undefined) !== (value.themes === undefined), 'Theme requires one selected body source')));
export type RegistryThemeCatalogEntryV1 = z.infer<typeof RegistryThemeCatalogEntryV1Schema>;

export type RegistryThemeAcquisitionV1 = Readonly<{ item: import('./registryItemsV1.js').RegistryItemV1 & Readonly<{ payload: Extract<RegistryThemePayloadV1, { state: 'ready' }> }>; provenance: import('./registryItemsV1.js').RegistryProvenanceV1 }>;
