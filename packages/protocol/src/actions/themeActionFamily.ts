import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { readRecord } from '../inputs/inputRecords.js';
import { THEME_ACTION_IDS, THEME_ACTION_ID_LIST, type ThemeActionId } from './themeActionIdsV1.js';
import { ThemeProfileSourceSchema, ThemeReferenceSchema, ThemeMiniatureDataSchema,
  parseThemeProfileDocument, type ThemeProfileDocument } from '../account/settings/themeProfiles.js';
import { RegistryItemPointerV1Schema } from '../registries/registryContentRefV1.js';
import { RegistryItemSummaryV1Schema, RegistryProvenanceV1Schema } from '../registries/registryItemsV1.js';
import { RegistryThemeListingV1Schema } from '../registries/registryThemeV1.js';
import { SocketRpcAnsweringClientCandidateV1Schema } from '../rpc/answeringClient.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import type { ActionExecutorContext, HostReviewedChildrenPlanV1 } from './executor/types.js';

export { THEME_ACTION_IDS, THEME_ACTION_ID_LIST, isThemeActionId, type ThemeActionId } from './themeActionIdsV1.js';
const identifier = z.string().check(z.minLength(1));
const mode = z.enum(['light', 'dark']);
export const ThemePresentationCompatibilitySchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['supported', 'partial']), requiresAppVersion: z.optional(z.string()), unsupportedPaths: z.array(z.string()),
}));
/** Raw presentation is the retained document authority; MODEL alone parses its known fields. */
export const ThemeProfileDocumentSchema = lazyZodSchema(() => z.pipe(z.strictObject({
  profile: z.unknown(), raw: z.unknown(), compatibility: ThemePresentationCompatibilitySchema,
}), z.transform((value, context): ThemeProfileDocument => {
  const parsed = parseThemeProfileDocument(value.raw);
  if (parsed.ok) return parsed.document;
  context.issues.push({ code: 'custom', message: 'theme_document_invalid', input: undefined });
  return z.NEVER;
})));
export const ThemeLibraryEntrySchema = lazyZodSchema(() => z.strictObject({
  id: identifier, reference: ThemeReferenceSchema, name: z.string(), mode, source: ThemeProfileSourceSchema,
  editable: z.boolean(), deletable: z.boolean(), compatibility: ThemePresentationCompatibilitySchema,
  miniature: ThemeMiniatureDataSchema,
}));
export const ThemeSelectionSchema = lazyZodSchema(() => z.strictObject({
  light: z.nullable(ThemeReferenceSchema), dark: z.nullable(ThemeReferenceSchema),
}));
/** Wire addresses are structural; the emitting surface registry owns its vocabulary. */
export const ThemeSurfaceAddressSchema = lazyZodSchema(() => z.strictObject({
  surface: z.string(), part: z.string(), state: z.optional(z.string()),
}));
export type ThemeSurfaceAddress = z.infer<typeof ThemeSurfaceAddressSchema>;
export const ThemeCssRangeSchema = lazyZodSchema(() => z.strictObject({
  start: z.number(), end: z.number(), line: z.number(), column: z.number(),
}));
export type ThemeCssRange = Readonly<z.infer<typeof ThemeCssRangeSchema>>;
export const ThemeCssRuleCoverageSchema = lazyZodSchema(() => z.strictObject({
  ruleIndex: z.number(), range: ThemeCssRangeSchema, selector: z.string(), native: z.boolean(),
  reasons: z.array(z.strictObject({ kind: z.enum(['selector', 'property', 'value', 'condition', 'syntax', 'stripped']),
    range: ThemeCssRangeSchema, property: z.optional(z.string()) })),
}));
type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ThemeCssRuleCoverage = DeepReadonly<z.infer<typeof ThemeCssRuleCoverageSchema>>;
export const ThemeCssCoverageSchema = lazyZodSchema(() => z.strictObject({
  total: z.number(), native: z.number(), webOnly: z.number(), affectedSurfaces: z.array(ThemeSurfaceAddressSchema),
  hides: z.array(z.strictObject({ address: ThemeSurfaceAddressSchema, range: ThemeCssRangeSchema,
    mode: z.enum(['light', 'dark', 'both']) })),
}));
export type ThemeCssCoverage<Address extends ThemeSurfaceAddress = ThemeSurfaceAddress> = Readonly<{
  total: number; native: number; webOnly: number; affectedSurfaces: readonly Address[];
  hides: readonly Readonly<{ address: Address; range: ThemeCssRange; mode: 'light' | 'dark' | 'both' }>[];
}>;
export const ThemeCssDetailedCoverageSchema = lazyZodSchema(() => z.extend(ThemeCssCoverageSchema, {
  rules: z.array(ThemeCssRuleCoverageSchema), stripped: z.array(z.strictObject({ range: ThemeCssRangeSchema, reason: z.string() })),
}));
export type ThemeCssDetailedCoverage<Address extends ThemeSurfaceAddress = ThemeSurfaceAddress> = ThemeCssCoverage<Address> & Readonly<{
  rules: readonly ThemeCssRuleCoverage[]; stripped: readonly Readonly<{ range: ThemeCssRange; reason: string }>[];
}>;
export const ThemeSurfacePaintSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('token'), ref: z.string() }),
  z.strictObject({ kind: z.literal('derived'), from: z.tuple([z.string()], z.string()) }),
  z.strictObject({ kind: z.literal('fixed') }),
]));
export type ThemeSurfacePaintSource = DeepReadonly<z.infer<typeof ThemeSurfacePaintSourceSchema>>;
export const ThemeSurfacePaintRoleSchema = lazyZodSchema(() => z.strictObject({
  facet: z.enum(['background', 'foreground', 'border']), source: ThemeSurfacePaintSourceSchema,
}));
export type ThemeSurfacePaintRole = DeepReadonly<z.infer<typeof ThemeSurfacePaintRoleSchema>>;
export const ThemeSurfacePaintDescriptorSchema = lazyZodSchema(() => z.strictObject({
  address: ThemeSurfaceAddressSchema, selector: z.string(), label: z.string(),
  paintRoles: z.array(ThemeSurfacePaintRoleSchema),
}));
const referenceInput = lazyZodSchema(() => z.strictObject({ ref: ThemeReferenceSchema }));
const applied = lazyZodSchema(() => z.strictObject({ clientId: z.optional(identifier), mode }));
const entryResult = lazyZodSchema(() => z.strictObject({ entry: ThemeLibraryEntrySchema }));
const restoredResult = lazyZodSchema(() => z.strictObject({ restored: ThemeSelectionSchema }));
const file = lazyZodSchema(() => z.strictObject({ name: z.string(), text: z.string() }));
export const ThemeRegistryItemKeySchema = lazyZodSchema(() => z.pick(RegistryItemPointerV1Schema, { sourceId: true, itemId: true }));
export type ThemeRegistryItemKey = z.infer<typeof ThemeRegistryItemKeySchema>;
/** Portable selected-listing projection; React detail and current preview stay client-local. */
export const ThemeStoreListingViewSchema = lazyZodSchema(() => z.strictObject({
  pointer: RegistryItemPointerV1Schema, summary: RegistryItemSummaryV1Schema,
  metadata: RegistryThemeListingV1Schema, provenance: RegistryProvenanceV1Schema,
}));
export type ThemeStoreListingView = z.infer<typeof ThemeStoreListingViewSchema>;
export const ThemeStoreFaceCoverageSchema = lazyZodSchema(() => z.strictObject({
  faceId: identifier, coverage: ThemeCssCoverageSchema,
}));
export type ThemeStoreFaceCoverage = DeepReadonly<z.infer<typeof ThemeStoreFaceCoverageSchema>>;
export const ThemeInstallFaceOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ faceId: identifier, status: z.literal('saved'), entry: ThemeLibraryEntrySchema }),
  z.strictObject({ faceId: identifier, status: z.literal('failed'), error: z.strictObject({ code: identifier }) }),
]));
export type ThemeInstallFaceOutcome = DeepReadonly<z.infer<typeof ThemeInstallFaceOutcomeSchema>>;
export const ThemeInstallResultSchema = lazyZodSchema(() => z.strictObject({ faces: z.array(ThemeInstallFaceOutcomeSchema) }));
export type ThemeInstallResult = DeepReadonly<z.infer<typeof ThemeInstallResultSchema>>;
export const ThemeActionInputSchemas = {
  [THEME_ACTION_IDS.list]: z.strictObject({ mode: z.optional(mode), includeDevices: z.optional(z.boolean()) }),
  [THEME_ACTION_IDS.get]: z.strictObject({ ref: ThemeReferenceSchema,
    include: z.optional(z.array(z.enum(['document', 'guide', 'coverage', 'surfaceMap']))) }),
  [THEME_ACTION_IDS.tryOn]: z.strictObject({ document: ThemeProfileDocumentSchema, mode,
    origin: z.strictObject({ kind: z.enum(['agent', 'editor', 'store']), listing: z.optional(ThemeRegistryItemKeySchema) }),
    group: z.optional(z.string()) }),
  [THEME_ACTION_IDS.revert]: z.strictObject({ previewRef: identifier }),
  [THEME_ACTION_IDS.keep]: z.strictObject({ previewRef: identifier }),
  [THEME_ACTION_IDS.save]: z.strictObject({ document: ThemeProfileDocumentSchema, ref: z.optional(ThemeReferenceSchema) }),
  [THEME_ACTION_IDS.duplicate]: referenceInput,
  [THEME_ACTION_IDS.apply]: z.strictObject({ ref: z.nullable(ThemeReferenceSchema), mode, clientId: z.optional(identifier) }),
  [THEME_ACTION_IDS.undo]: z.strictObject({ undoHandle: identifier }),
  [THEME_ACTION_IDS.delete]: referenceInput,
  [THEME_ACTION_IDS.storeGet]: z.strictObject({ listing: z.partial(RegistryItemPointerV1Schema, { version: true }) }),
  [THEME_ACTION_IDS.install]: z.strictObject({ listing: ThemeRegistryItemKeySchema, faceIds: z.optional(z.array(identifier)) }),
  [THEME_ACTION_IDS.uninstall]: z.strictObject({ listing: ThemeRegistryItemKeySchema }),
  [THEME_ACTION_IDS.import]: z.strictObject({ file }),
  [THEME_ACTION_IDS.export]: referenceInput,
  [THEME_ACTION_IDS.sharePlugin]: z.strictObject({ refs: z.array(ThemeReferenceSchema).check(z.minLength(1)),
    machineId: identifier, path: identifier }),
} as const;
export const ThemeActionOutputSchemas = {
  [THEME_ACTION_IDS.list]: z.strictObject({ themes: z.array(ThemeLibraryEntrySchema),
    devices: z.optional(z.array(SocketRpcAnsweringClientCandidateV1Schema)) }),
  [THEME_ACTION_IDS.get]: z.strictObject({ entry: ThemeLibraryEntrySchema, document: z.optional(ThemeProfileDocumentSchema),
    guide: z.optional(z.string()), coverage: z.optional(ThemeCssDetailedCoverageSchema),
    surfaceMap: z.optional(z.array(ThemeSurfacePaintDescriptorSchema)) }),
  [THEME_ACTION_IDS.tryOn]: z.strictObject({ previewRef: identifier, coverage: ThemeCssCoverageSchema,
    compatibility: ThemePresentationCompatibilitySchema }),
  [THEME_ACTION_IDS.revert]: restoredResult,
  [THEME_ACTION_IDS.keep]: z.strictObject({ entry: ThemeLibraryEntrySchema, applied, undoHandle: identifier }),
  [THEME_ACTION_IDS.save]: z.strictObject({ entry: ThemeLibraryEntrySchema, undoHandle: z.optional(identifier) }),
  [THEME_ACTION_IDS.duplicate]: entryResult,
  [THEME_ACTION_IDS.apply]: z.strictObject({ applied, undoHandle: identifier }),
  [THEME_ACTION_IDS.undo]: restoredResult,
  [THEME_ACTION_IDS.delete]: z.strictObject({ deleted: ThemeReferenceSchema }),
  [THEME_ACTION_IDS.storeGet]: z.strictObject({ listing: ThemeStoreListingViewSchema, faces: z.array(ThemeProfileDocumentSchema),
    coverage: z.array(ThemeStoreFaceCoverageSchema) }),
  [THEME_ACTION_IDS.install]: ThemeInstallResultSchema,
  [THEME_ACTION_IDS.uninstall]: z.strictObject({ removedFaces: z.array(identifier), selectionFallback: z.optional(ThemeSelectionSchema) }),
  [THEME_ACTION_IDS.import]: entryResult,
  [THEME_ACTION_IDS.export]: z.strictObject({ file }),
  [THEME_ACTION_IDS.sharePlugin]: z.strictObject({ project: identifier, archive: identifier, digest: identifier }),
} as const;
export type ThemeActionInput<Id extends ThemeActionId = ThemeActionId> = z.infer<(typeof ThemeActionInputSchemas)[Id]>;
export type ThemeActionOutput<Id extends ThemeActionId = ThemeActionId> = DeepReadonly<z.infer<(typeof ThemeActionOutputSchemas)[Id]>>;
export type ThemeActionRequest = { [Id in ThemeActionId]: Readonly<{
  actionId: Id; input: ThemeActionInput<Id>; context: ActionExecutorContext;
}> }[ThemeActionId];
const titles = {
  [THEME_ACTION_IDS.list]: 'List themes', [THEME_ACTION_IDS.get]: 'Read a theme',
  [THEME_ACTION_IDS.tryOn]: 'Try on a theme', [THEME_ACTION_IDS.revert]: 'Revert a theme preview',
  [THEME_ACTION_IDS.keep]: 'Keep the current theme preview', [THEME_ACTION_IDS.save]: 'Save a theme',
  [THEME_ACTION_IDS.duplicate]: 'Duplicate a theme', [THEME_ACTION_IDS.apply]: 'Apply a theme',
  [THEME_ACTION_IDS.undo]: 'Undo the last theme operation', [THEME_ACTION_IDS.delete]: 'Delete a theme',
  [THEME_ACTION_IDS.storeGet]: 'Read a Store theme', [THEME_ACTION_IDS.install]: 'Install a Store theme',
  [THEME_ACTION_IDS.uninstall]: 'Uninstall a Store theme',
  [THEME_ACTION_IDS.import]: 'Import a theme file', [THEME_ACTION_IDS.export]: 'Export a theme file',
  [THEME_ACTION_IDS.sharePlugin]: 'Share themes as a plugin',
} satisfies Record<ThemeActionId, string>;
export const THEME_SHARE_PLUGIN_CHILD_ROLES = { scaffold: 'theme.share.scaffold', pack: 'theme.share.pack' } as const;
/** One builder supplies both the reviewed scopes and concrete child operands. */
export function themeSharePluginChildInputs(input: ThemeActionInput<typeof THEME_ACTION_IDS.sharePlugin>) {
  return {
    scaffold: { targetDir: input.path, machineId: input.machineId, template: 'themes' as const,
      id: 'local.shared-themes', name: 'Shared themes' },
    pack: { locator: input.path, machineId: input.machineId },
  };
}
function themeSharePluginReviewedChildren(input: unknown): HostReviewedChildrenPlanV1['children'] {
  const children = themeSharePluginChildInputs(ThemeActionInputSchemas[THEME_ACTION_IDS.sharePlugin].parse(input));
  return [
    { action: 'plugins.scaffold', role: THEME_SHARE_PLUGIN_CHILD_ROLES.scaffold, scopeInput: children.scaffold },
    { action: 'plugins.pack', role: THEME_SHARE_PLUGIN_CHILD_ROLES.pack, input: children.pack },
  ];
}
function hasThemeAuthorCss(input: unknown): boolean {
  const document = readRecord(readRecord(input).document);
  const css = readRecord(document.profile).css;
  return typeof css === 'string' && css.length > 0;
}
function createThemeActionSpecs() {
  return THEME_ACTION_ID_LIST.map((id): Omit<PreNormalizedActionSpec, 'id'> & { id: ThemeActionId } => ({
    id, title: titles[id], description: 'Use the answering client’s shared theme library and temporary preview owner. Try on before Keep; immutable themes must be duplicated before editing. Connected client routing never queues offline effects.',
    approval: { result: 'required' },
    approvalPolicy: id === THEME_ACTION_IDS.delete || id === THEME_ACTION_IDS.uninstall || id === THEME_ACTION_IDS.sharePlugin
      ? { agentDefault: 'authority', uiConfirmation: 'direct' }
      : id === THEME_ACTION_IDS.install
        ? { uiConfirmation: 'direct' }
        : { uiConfirmation: 'direct',
          ...(id === THEME_ACTION_IDS.tryOn || id === THEME_ACTION_IDS.save
            ? { agentDefaultForInput: hasThemeAuthorCss } : {}) },
    safety: 'safe',
    ...(id === THEME_ACTION_IDS.sharePlugin ? { hostReviewedChildren: themeSharePluginReviewedChildren } : {}),
    sideEffectClass: id === THEME_ACTION_IDS.list || id === THEME_ACTION_IDS.get || id === THEME_ACTION_IDS.storeGet || id === THEME_ACTION_IDS.export ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
    bindings: { mcpToolName: id.replace(/[.]/g, '_') },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [] },
    toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
    inputSchema: ThemeActionInputSchemas[id], outputSchema: ThemeActionOutputSchemas[id], inputHints: { fields: [] },
  }));
}
export const THEME_ACTION_SPECS: ReturnType<typeof createThemeActionSpecs> = lazyActionSpecArray(createThemeActionSpecs);
