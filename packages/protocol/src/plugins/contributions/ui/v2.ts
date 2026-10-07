import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
import { PluginUiWidgetAreaDeclarationsV1Schema, type PluginUiWidgetAreaDeclarationV1 } from './widgetAreas.js';
export { PluginUiWidgetAreaDeclarationV1Schema, PluginUiWidgetAreaDeclarationsV1Schema } from './widgetAreas.js';
export type { PluginUiWidgetAreaDeclarationV1 } from './widgetAreas.js';
import { PluginDeclarativeMetricNodeV1Schema, PluginDeclarativeTableNodeV1Schema, PluginDeclarativeRowsNodeV1Schema, PluginDeclarativeChartNodeV1Schema, type PluginDeclarativeDataNodeV1 } from './declarativeDataV1.js';
export * from './declarativeDataV1.js';
import { InputHintsSchema, InputPathSchema, type InputHints } from '../../../inputs/inputFields.js';
import { PluginInvocableActionIdSchema } from '../../../actions/pluginActionSurface.js';
import { hasValidPluginConnectedAccountPurposeBindingsV2 } from '../../actions/v2.js';
import { WidgetConnectedAccountPurposeBindingV1Schema, type WidgetConnectedAccountPurposeBindingV1 } from '../../../widgets/widgetConnectedAccountPurposeBindingV1.js';
import { asProtocolZod } from "../../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema, PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../../contributionIdentity.js';
import { PluginIdSchema } from '../../pluginId.js';
import {
  PluginCollectionMemberNameV1Schema,
  PluginCollectionProjectedScalarFieldRefV1Schema,
} from '../../data/collectionContributionV1.js';
import { PluginUiHostMethodV1Schema } from '../../ui/hostApiDefinition.js';
import {
  PluginUiInstanceKeyV1Schema,
  PluginUiLaunchInputV1Schema,
} from '../../ui/semanticCommands.js';
import {
  ComposerTransactionV1Schema,
  type ComposerTransactionV1,
} from '../../ui/composer.js';
import { PluginUiTargetedContributionPointRefV1Schema } from '../../ui/targetedContributions.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
  type PluginContributionReferenceV2,
  PluginLocalizedStringV2Schema,
  PluginLocalizedMarkdownV2Schema,
  type PluginLocalizedStringV2,
} from '../publicTypes.js';
import {
  PluginUiDestinationInstancePolicyV1Schema,
  PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1,
  PLUGIN_UI_INLINE_SURFACE_SLOTS_V1,
  isPluginUiAuthoredViewInlineSurfaceRoleV1,
  type PluginUiAuthoredViewInlineSurfaceRoleV1,
  type PluginUiDestinationInstancePolicyV1,
} from './surfaceRegistry.js';
import { preflightPluginDeclarativeDocumentV1 } from './declarativeDocumentPreflightV1.js';
import { PluginHostedHtmlSourceV1Schema } from './hostedHtmlSourceV1.js';
import { PluginUiHostedHtmlRequestedCapabilitiesV1Schema } from './hostedHtmlCapabilitiesV1.js';
import {
  PluginUiPageHeaderActionV1Schema,
  type PluginUiPageHeaderActionV1,
  type PluginUiPageHeaderActionV1Input,
} from './sessionHeaderActions.js';
import {
  PluginSurfaceAppTargetV1Schema,
  PluginSurfaceBrowserTargetV1Schema,
  PluginSurfaceProjectTargetV1Schema,
  PluginSurfaceServicesTargetV1Schema,
  PluginSurfaceSessionTargetV1Schema,
  type PluginSurfaceTargetV1,
} from './surfaceTargets.js';
import { PluginUiIconTokenV1Schema, PluginUiToneV1Schema } from './tokens.js';
import {
  PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH,
  validatePluginUiRendererChainFieldsV1,
} from './rendererChainBinding.js';

export type { PluginUiIconTokenV1 } from './tokens.js';

/**
 * Settings controls a declarative `field` can bind. Exported because the CLI
 * evaluated model validates the control against the declared setting and must
 * name the same type rather than keeping a second copy of it.
 */
export const PluginDeclarativeControlV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), settingId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
  z.object({ kind: z.literal('number'), settingId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
  z.object({ kind: z.literal('toggle'), settingId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
  z.object({ kind: z.literal('select'), settingId: asProtocolZod(PluginContributionLocalIdSchema), options: z.array(z.object({ value: PluginJsonValueV2Schema, label: PluginLocalizedStringV2Schema }).strict()) }).strict(),
  z.object({ kind: z.literal('secret'), settingId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
]));
export type PluginDeclarativeControlV2 = z.infer<typeof PluginDeclarativeControlV2Schema>;
/**
 * The single declarative tone/variant vocabulary. Producers (CLI declarative-model
 * evaluation) and the host renderer both bind to these enums so a new member cannot
 * silently render as `default`.
 */
export const PluginDeclarativeToneV2Schema = lazyZodSchema(() => z.enum(['default', 'muted', 'success', 'warning', 'danger']));
export type PluginDeclarativeToneV2 = z.infer<typeof PluginDeclarativeToneV2Schema>;
export const PluginDeclarativeActionVariantV2Schema = lazyZodSchema(() => z.enum(['primary', 'secondary', 'destructive']));
export type PluginDeclarativeActionVariantV2 = z.infer<typeof PluginDeclarativeActionVariantV2Schema>;
/**
 * The collection states a declarative document can express. A declarative tree is
 * authored data, so the plugin states which one holds; the host never infers one.
 * The vocabulary is closed for the same reason `tone` is: the renderer keys a
 * `Record<PluginDeclarativeStateV2, …>` off it, so a new member fails to compile
 * rather than rendering as an untitled block.
 */
export const PluginDeclarativeStateV2Schema = lazyZodSchema(() => z.enum(['empty', 'loading', 'error']));
export type PluginDeclarativeStateV2 = z.infer<typeof PluginDeclarativeStateV2Schema>;
/**
 * Key/value detail entries. Bounded here rather than by the node budget because
 * one `metadata` node costs one node no matter how many rows it declares.
 */
export const MAX_PLUGIN_DECLARATIVE_METADATA_ENTRIES_V2 = 32;
export const PluginDeclarativeMetadataEntryV2Schema = lazyZodSchema(() => z.object({
  label: PluginLocalizedStringV2Schema,
  value: PluginLocalizedStringV2Schema,
  tone: PluginDeclarativeToneV2Schema.optional(),
}).strict());
export type PluginDeclarativeMetadataEntryV2 = z.infer<typeof PluginDeclarativeMetadataEntryV2Schema>;

/**
 * `list` owns the collection semantics (accessible list role + name); `section`
 * owns the visible titled grouping of rows; `item` is the row; `state` is the
 * empty/loading/error placeholder that stands in for rows. They are separate
 * members because each maps onto a different canonical host owner (list
 * container, `ItemGroup`, `Item`, state block) and carries different semantics.
 *
 * Because they are separate, the grammar has to say which one can hold which:
 * the predecessor let any node sit under any container, so a manifest could
 * declare a form field inside an `actionPanel` toolbar or a `list` inside a
 * `list` and the host would render it into a role it has no meaning in. The
 * semantic containers below are therefore bound to their real children, while
 * `stack` and `group` stay free-form — that is what they are for.
 */
/**
 * The declarative Composer mutation uses an explicit effect. The mounted
 * host supplies the Composer ref; author data can name only the exact CAS
 * transaction it wants applied through the incumbent Composer owner.
 */
export const PluginDeclarativeComposerApplyEffectV1Schema = lazyZodSchema(() => ComposerTransactionV1Schema.extend({
  kind: z.literal('composerApply'),
}).strict());
export type PluginDeclarativeComposerApplyEffectV1 =
  ComposerTransactionV1 & Readonly<{ kind: 'composerApply' }>;

const DeclarativeActionNodeSchema = lazyZodSchema(() => z.object({
  kind: z.literal('action'),
  action: asProtocolZod(PluginContributionReferenceV2Schema).optional(),
  /** A request only: the mounted source adapter supplies current caller and Action policy. */
  hostAction: z.lazy(() => PluginInvocableActionIdSchema).optional(),
  effect: PluginDeclarativeComposerApplyEffectV1Schema.optional(),
  label: PluginLocalizedStringV2Schema,
  variant: PluginDeclarativeActionVariantV2Schema.optional(),
  input: PluginJsonValueV2Schema.optional(),
}).strict().superRefine((node, ctx) => {
  if ([node.action, node.hostAction, node.effect].filter((value) => value !== undefined).length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['action'],
      message: 'A declarative action must name exactly one contributed Action, host Action, or effect.',
    });
  }
  if (node.effect !== undefined && node.input !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['input'],
      message: 'A declarative composerApply effect cannot carry Action input.',
    });
  }
}));
const DeclarativeItemNodeSchema = lazyZodSchema(() => z.object({ kind: z.literal('item'), title: PluginLocalizedStringV2Schema, subtitle: PluginLocalizedStringV2Schema.optional(), detail: PluginLocalizedStringV2Schema.optional(), icon: PluginUiIconTokenV1Schema.optional(), tone: PluginDeclarativeToneV2Schema.optional(), action: asProtocolZod(PluginContributionReferenceV2Schema).optional(), input: PluginJsonValueV2Schema.optional() }).strict());
export const PluginDeclarativeStateNodeV2Schema = lazyZodSchema(() => z.object({ kind: z.literal('state'), state: PluginDeclarativeStateV2Schema, title: PluginLocalizedStringV2Schema, description: PluginLocalizedStringV2Schema.optional(), icon: PluginUiIconTokenV1Schema.optional() }).strict());
/**
 * A symbolic target-local reference. The mounted target is ambient and the
 * normalizer later supplies the admitted contributor generation; authored
 * documents can never fabricate either fact.
 */
export const PluginDeclarativeTargetedSurfaceReferenceV1Schema = lazyZodSchema(() => z.object({
  point: asProtocolZod(PluginUiTargetedContributionPointRefV1Schema),
  contributor: z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
  role: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
export type PluginDeclarativeTargetedSurfaceReferenceV1 = z.infer<
  typeof PluginDeclarativeTargetedSurfaceReferenceV1Schema
>;
export const PluginDeclarativeTargetedSurfaceNodeV2Schema = lazyZodSchema(() => z.object({
  kind: z.literal('targetedSurface'),
  surface: PluginDeclarativeTargetedSurfaceReferenceV1Schema,
  input: PluginUiLaunchInputV1Schema,
  instanceKey: PluginUiInstanceKeyV1Schema,
  fallback: PluginDeclarativeStateNodeV2Schema.optional(),
}).strict());
const DeclarativeRowNodeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [DeclarativeItemNodeSchema, PluginDeclarativeStateNodeV2Schema]));
const DeclarativeSectionNodeSchema = lazyZodSchema(() => z.object({ kind: z.literal('section'), title: PluginLocalizedStringV2Schema.optional(), footer: PluginLocalizedStringV2Schema.optional(), children: z.array(DeclarativeRowNodeSchema) }).strict());
const DeclarativeListNodeSchema = lazyZodSchema(() => z.object({ kind: z.literal('list'), label: PluginLocalizedStringV2Schema.optional(), children: z.array(z.discriminatedUnion('kind', [DeclarativeSectionNodeSchema, DeclarativeItemNodeSchema, PluginDeclarativeStateNodeV2Schema])) }).strict());
const DeclarativeActionPanelNodeSchema = lazyZodSchema(() => z.object({ kind: z.literal('actionPanel'), title: PluginLocalizedStringV2Schema.optional(), children: z.array(DeclarativeActionNodeSchema) }).strict());
const DeclarativeMetadataNodeSchema = lazyZodSchema(() => z.object({ kind: z.literal('metadata'), title: PluginLocalizedStringV2Schema.optional(), entries: z.array(PluginDeclarativeMetadataEntryV2Schema).min(1).max(MAX_PLUGIN_DECLARATIVE_METADATA_ENTRIES_V2) }).strict());
const PluginDeclarativeCollectionListParametersV1Schema = lazyZodSchema(() => z.record(
  PluginCollectionMemberNameV1Schema,
  z.union([z.string(), z.number().finite(), z.boolean()]),
));
export type PluginDeclarativeCollectionListSourceV1 = Readonly<{
  collectionId: string;
  uiQueryId: string;
  parameters?: Readonly<Record<string, string | number | boolean>>;
}>;
/** Shared verbatim by the authoring grammar and the final projected model. */
export const PluginDeclarativeCollectionListSourceV1Schema = lazyZodSchema(() => z.object({
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  uiQueryId: PluginCollectionMemberNameV1Schema,
  parameters: PluginDeclarativeCollectionListParametersV1Schema.optional(),
}).strict());
export const PluginDeclarativeCollectionListProjectionV1Schema = lazyZodSchema(() => z.object({
  titleField: PluginCollectionProjectedScalarFieldRefV1Schema,
  subtitleField: PluginCollectionProjectedScalarFieldRefV1Schema.optional(),
  detailField: PluginCollectionProjectedScalarFieldRefV1Schema.optional(),
  badgeField: PluginCollectionProjectedScalarFieldRefV1Schema.optional(),
  statusField: PluginCollectionProjectedScalarFieldRefV1Schema.optional(),
}).strict());
export type PluginDeclarativeCollectionListProjectionV1 = z.infer<
  typeof PluginDeclarativeCollectionListProjectionV1Schema
>;

/**
 * A collection row command names one already-admitted same-plugin target. The
 * row context is fixed by the host at invocation time; author-supplied input,
 * field mappings, Account facts, and caller/origin fields are deliberately
 * outside this grammar.
 */
export const PluginCollectionRowCommandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
  z.object({
    kind: z.literal('openSurface'),
    destination: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
]));
export type PluginCollectionRowCommandV1 = z.infer<typeof PluginCollectionRowCommandV1Schema>;

/**
 * This is a packed semantic action list, not arbitrary row data. A fixed
 * ceiling keeps one declarative node from expanding unbounded host chrome.
 */
export const MAX_PLUGIN_DECLARATIVE_COLLECTION_ROW_SECONDARY_COMMANDS_V1 = 16;
const DeclarativeCollectionListNodeSchema = lazyZodSchema(() => z.object({
  kind: z.literal('collectionList'),
  /** Optional accessible collection name; the renderer resolves it at its mounted localization owner. */
  label: PluginLocalizedStringV2Schema.optional(),
  source: PluginDeclarativeCollectionListSourceV1Schema,
  projection: PluginDeclarativeCollectionListProjectionV1Schema,
  primaryCommand: PluginCollectionRowCommandV1Schema.optional(),
  secondaryCommands: z.array(PluginCollectionRowCommandV1Schema)
    .min(1)
    .max(MAX_PLUGIN_DECLARATIVE_COLLECTION_ROW_SECONDARY_COMMANDS_V1)
    .optional(),
}).strict());

export type PluginDeclarativeActionNodeV2 = z.infer<typeof DeclarativeActionNodeSchema>;
export type PluginDeclarativeItemNodeV2 = z.infer<typeof DeclarativeItemNodeSchema>;
export type PluginDeclarativeStateNodeV2 = z.infer<typeof PluginDeclarativeStateNodeV2Schema>;
export type PluginDeclarativeTargetedSurfaceNodeV2 = z.infer<typeof PluginDeclarativeTargetedSurfaceNodeV2Schema>;
export type PluginDeclarativeRowNodeV2 = z.infer<typeof DeclarativeRowNodeSchema>;
export type PluginDeclarativeSectionNodeV2 = z.infer<typeof DeclarativeSectionNodeSchema>;
export type PluginDeclarativeListNodeV2 = z.infer<typeof DeclarativeListNodeSchema>;
export type PluginDeclarativeActionPanelNodeV2 = z.infer<typeof DeclarativeActionPanelNodeSchema>;
export type PluginDeclarativeMetadataNodeV2 = z.infer<typeof DeclarativeMetadataNodeSchema>;
export type PluginDeclarativeCollectionListNodeV2 = z.infer<typeof DeclarativeCollectionListNodeSchema>;

/**
 * The declarative document vocabulary, as a real recursive type.
 *
 * A recursive Zod schema cannot infer its own output, so the type is written
 * once here and the schema is annotated WITH it. The predecessor annotation was
 * `z.ZodType<unknown>`, which erased the vocabulary at the package boundary: the
 * declaration output was byte-identical whether the union had 13 members or 14,
 * so the CLI evaluated model hand-redeclared all 13 and adding a kind here
 * compiled cleanly everywhere. `unknown` is not a contract. Every downstream
 * owner — the CLI evaluated model, the daemon generation projection and the one
 * host renderer — now binds to this type and fails to compile on a new member.
 */
export type PluginDeclarativeNodeV2 =
  | PluginDeclarativeDataNodeV1
  | Readonly<{ kind: 'dragSource'; sourceId: PluginContributionReferenceV2; reference: PluginJsonValueV2; organizing?: boolean; children: readonly PluginDeclarativeNodeV2[] }>
  | Readonly<{ kind: 'dropTarget'; targetId: PluginContributionReferenceV2; input?: PluginJsonValueV2; children: readonly PluginDeclarativeNodeV2[] }>
  /** One of the page's declared widget areas; the host draws everything inside it. */
  | Readonly<{ kind: 'widgetArea'; area: string; context?: Readonly<Record<string, PluginJsonValueV2>> }>
  | Readonly<{ kind: 'text'; text: PluginLocalizedStringV2; tone?: PluginDeclarativeToneV2 }>
  | Readonly<{ kind: 'markdown'; text: PluginLocalizedStringV2 }>
  | Readonly<{ kind: 'stack'; direction?: 'vertical' | 'horizontal'; gap?: 'small' | 'medium' | 'large'; children: readonly PluginDeclarativeNodeV2[] }>
  | Readonly<{ kind: 'group'; title?: PluginLocalizedStringV2; description?: PluginLocalizedStringV2; children: readonly PluginDeclarativeNodeV2[] }>
  | Readonly<{ kind: 'field'; label: PluginLocalizedStringV2; description?: PluginLocalizedStringV2; control: PluginDeclarativeControlV2 }>
  | Readonly<{ kind: 'status'; label: PluginLocalizedStringV2; value: PluginLocalizedStringV2; tone?: PluginDeclarativeToneV2 }>
  | PluginDeclarativeActionNodeV2
  | PluginDeclarativeListNodeV2
  | PluginDeclarativeSectionNodeV2
  | PluginDeclarativeItemNodeV2
  | PluginDeclarativeStateNodeV2
  | PluginDeclarativeTargetedSurfaceNodeV2
  | PluginDeclarativeMetadataNodeV2
  | PluginDeclarativeActionPanelNodeV2
  | PluginDeclarativeCollectionListNodeV2;

export const PluginDeclarativeNodeV2Schema: z.ZodType<PluginDeclarativeNodeV2> = z.lazy(() => z.discriminatedUnion('kind', [
  PluginDeclarativeMetricNodeV1Schema, PluginDeclarativeTableNodeV1Schema, PluginDeclarativeRowsNodeV1Schema, PluginDeclarativeChartNodeV1Schema,
  z.object({ kind: z.literal('dragSource'), sourceId: asProtocolZod(PluginContributionReferenceV2Schema), reference: PluginJsonValueV2Schema, organizing: z.boolean().optional(), children: z.array(PluginDeclarativeNodeV2Schema) }).strict(),
  z.object({ kind: z.literal('dropTarget'), targetId: asProtocolZod(PluginContributionReferenceV2Schema), input: PluginJsonValueV2Schema.optional(), children: z.array(PluginDeclarativeNodeV2Schema) }).strict(),
  z.object({ kind: z.literal('widgetArea'), area: asProtocolZod(PluginContributionLocalIdSchema), context: z.record(z.string(), PluginJsonValueV2Schema).optional() }).strict(),
  z.object({ kind: z.literal('text'), text: PluginLocalizedStringV2Schema, tone: PluginDeclarativeToneV2Schema.optional() }).strict(),
  z.object({ kind: z.literal('markdown'), text: PluginLocalizedMarkdownV2Schema }).strict(),
  z.object({ kind: z.literal('stack'), direction: z.enum(['vertical', 'horizontal']).optional(), gap: z.enum(['small', 'medium', 'large']).optional(), children: z.array(PluginDeclarativeNodeV2Schema) }).strict(),
  z.object({ kind: z.literal('group'), title: PluginLocalizedStringV2Schema.optional(), description: PluginLocalizedStringV2Schema.optional(), children: z.array(PluginDeclarativeNodeV2Schema) }).strict(),
  z.object({ kind: z.literal('field'), label: PluginLocalizedStringV2Schema, description: PluginLocalizedStringV2Schema.optional(), control: PluginDeclarativeControlV2Schema }).strict(),
  z.object({ kind: z.literal('status'), label: PluginLocalizedStringV2Schema, value: PluginLocalizedStringV2Schema, tone: PluginDeclarativeToneV2Schema.optional() }).strict(),
  DeclarativeActionNodeSchema,
  DeclarativeListNodeSchema,
  DeclarativeSectionNodeSchema,
  DeclarativeItemNodeSchema,
  PluginDeclarativeStateNodeV2Schema,
  PluginDeclarativeTargetedSurfaceNodeV2Schema,
  DeclarativeMetadataNodeSchema,
  DeclarativeActionPanelNodeSchema,
  DeclarativeCollectionListNodeSchema,
]));

/**
 * Static roots go through the same iterative document preflight as Resource
 * documents before this recursive grammar descends into their children.
 */
const PluginDeclarativeRendererRootV2Schema: z.ZodType<PluginDeclarativeNodeV2> = lazyZodSchema(() => z.unknown()
  .superRefine((root, context) => {
    const preflight = preflightPluginDeclarativeDocumentV1({ version: 1, root });
    if (preflight.ok) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: preflight.message,
    });
  })
  .pipe(PluginDeclarativeNodeV2Schema));
// The sole initial tuple contains only producer-backed methods, so a renderer
// can require exactly the same vocabulary every adapter negotiates.
const RequiredMethodsSchema = lazyZodSchema(() => z.array(PluginUiHostMethodV1Schema).optional());

/**
 * The outer renderer alone selects the live document Resource. Dynamic bytes
 * can replace only the document envelope/root; they cannot redeclare a MIME
 * type, target, method ceiling, or execution origin.
 */
export const PluginDeclarativeDocumentSourceV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('resource'),
  resourceId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
export type PluginDeclarativeDocumentSourceV1 = z.infer<typeof PluginDeclarativeDocumentSourceV1Schema>;

export const PluginUiRendererV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  // Only the self-contained by-value document declares requested capabilities:
  // an Artifact-backed or host-rendered renderer resolves its reach through the
  // installed plugin's own manifest and grants.
  z.object({ id: asProtocolZod(PluginContributionLocalIdSchema), kind: z.literal('hostedHtml'), source: PluginHostedHtmlSourceV1Schema, requiredHostMethods: RequiredMethodsSchema, requestedCapabilities: PluginUiHostedHtmlRequestedCapabilitiesV1Schema.optional() }).strict(),
  z.object({ id: asProtocolZod(PluginContributionLocalIdSchema), kind: z.literal('reactNative'), artifact: asProtocolZod(PluginContributionLocalIdSchema), requiredHostMethods: RequiredMethodsSchema }).strict(),
  z.object({ id: asProtocolZod(PluginContributionLocalIdSchema), kind: z.literal('hostedWeb'), source: z.object({ kind: z.literal('artifact'), artifact: asProtocolZod(PluginContributionLocalIdSchema) }).strict(), requiredHostMethods: RequiredMethodsSchema }).strict(),
  z.object({ id: asProtocolZod(PluginContributionLocalIdSchema), kind: z.literal('declarative'), root: PluginDeclarativeRendererRootV2Schema, documentSource: PluginDeclarativeDocumentSourceV1Schema.optional() }).strict(),
]));
export type PluginUiRendererV2 = z.infer<typeof PluginUiRendererV2Schema>;
export const MAX_PLUGIN_UI_PAGE_HEADER_ACTIONS_V1 = 16;
type PluginUiViewDestinationTargetKindV1 =
  typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number]['targetKind'];

const PluginUiViewTargetSchemaByKindV1 = Object.freeze({
  app: PluginSurfaceAppTargetV1Schema,
  session: PluginSurfaceSessionTargetV1Schema,
  project: PluginSurfaceProjectTargetV1Schema,
  browser: PluginSurfaceBrowserTargetV1Schema,
  services: PluginSurfaceServicesTargetV1Schema,
} satisfies Readonly<Record<PluginUiViewDestinationTargetKindV1, z.ZodType<PluginSurfaceTargetV1>>>);

/** Static presentation defaults only; the host and user still own final placement. */
export const MAX_PLUGIN_UI_DESTINATION_BADGE_UTF8_BYTES_V1 = 80;
export const MIN_PLUGIN_UI_DESTINATION_RANK_HINT_V1 = -10_000;
export const MAX_PLUGIN_UI_DESTINATION_RANK_HINT_V1 = 10_000;

function isWithinUtf8ByteLimit(value: string, limit: number): boolean {
  return new TextEncoder().encode(value).byteLength <= limit;
}

function createBoundedLocalizedStringSchema(maximumUtf8Bytes: number, label: string) {
  return PluginLocalizedStringV2Schema.superRefine((value, ctx) => {
    const strings = typeof value === 'string'
      ? [value]
      : [value.key, value.fallback];
    if (strings.every((candidate) => isWithinUtf8ByteLimit(candidate, maximumUtf8Bytes))) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} exceeds the ${maximumUtf8Bytes}-byte UTF-8 limit.`,
    });
  });
}

const PluginUiDestinationBadgeLabelV1Schema = createBoundedLocalizedStringSchema(
  MAX_PLUGIN_UI_DESTINATION_BADGE_UTF8_BYTES_V1,
  'Plugin destination badge label',
);
export const PluginUiDestinationBadgeV1Schema = lazyZodSchema(() => z.object({
  label: PluginUiDestinationBadgeLabelV1Schema,
  tone: PluginUiToneV1Schema.optional(),
}).strict());
export type PluginUiDestinationBadgeV1 = z.infer<typeof PluginUiDestinationBadgeV1Schema>;

export const PluginUiDestinationPlacementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rail') }).strict(),
  z.object({
    kind: z.literal('column'),
    column: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict(),
]));
export type PluginUiDestinationPlacementV1 = z.infer<typeof PluginUiDestinationPlacementV1Schema>;

export const PluginUiAppPageColumnV1Schema = lazyZodSchema(() => z.object({
  renderer: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
export type PluginUiAppPageColumnV1 = z.infer<typeof PluginUiAppPageColumnV1Schema>;

export const PluginUiDestinationRankHintV1Schema = lazyZodSchema(() => z.number().int().min(
  MIN_PLUGIN_UI_DESTINATION_RANK_HINT_V1,
).max(MAX_PLUGIN_UI_DESTINATION_RANK_HINT_V1).optional());

const PluginUiViewDestinationCommonShapeV2 = {
  id: asProtocolZod(PluginContributionLocalIdSchema),
  renderer: asProtocolZod(PluginContributionLocalIdSchema),
  fallbackRenderers: z.array(asProtocolZod(PluginContributionLocalIdSchema))
    .max(PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH - 1)
    .optional(),
  title: PluginLocalizedStringV2Schema.optional(),
  icon: PluginUiIconTokenV1Schema.optional(),
  badge: PluginUiDestinationBadgeV1Schema.optional(),
  rankHint: PluginUiDestinationRankHintV1Schema,
  instancePolicy: PluginUiDestinationInstancePolicyV1Schema.default('singleton'),
};

/**
 * Inline roles share `ui.views` authoring syntax but deliberately do not gain
 * destination-only metadata, instance policy, or header ownership.
 */
const PluginUiViewInlineCommonShapeV2 = {
  id: asProtocolZod(PluginContributionLocalIdSchema),
  renderer: asProtocolZod(PluginContributionLocalIdSchema),
  fallbackRenderers: z.array(asProtocolZod(PluginContributionLocalIdSchema))
    .max(PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH - 1)
    .optional(),
  title: PluginLocalizedStringV2Schema.optional(),
  icon: PluginUiIconTokenV1Schema.optional(),
};

export const PluginUiWidgetHomeV1Schema = lazyZodSchema(() => z.object({
  default: z.enum(['shown', 'available']),
}).strict());
export type PluginUiWidgetHomeV1 = z.infer<typeof PluginUiWidgetHomeV1Schema>;

/**
 * Page header actions are an `appPage` container capability, not a property of
 * every destination. Every other container declares the empty tuple so the one
 * grammar stays representable: TypeScript, the generated authoring JSON Schema
 * and this canonical parser then admit exactly the same declarations. A
 * `superRefine` here would be invisible to both other layers.
 */
const PluginUiViewHeaderActionsSchemaV2 = Object.freeze({
  appPage: z.array(PluginUiPageHeaderActionV1Schema)
    .max(MAX_PLUGIN_UI_PAGE_HEADER_ACTIONS_V1)
    .default([]),
  unsupported: z.array(z.never()).max(0).default([]),
});

/**
 * JSON Schema cannot represent a `superRefine` slot lookup. Build the input
 * union from the Registry rows themselves so generated authoring schema and
 * canonical parsing reject the same container/target pairs.
 */
function createPluginUiViewBindingSchemaV2() {
  const destinationVariants = PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1
    .filter((slot) => slot.container !== 'settingsPage')
    .map((slot) => z.object({
      ...PluginUiViewDestinationCommonShapeV2,
      // The generated authoring schema derives its policy from the same
      // registry row as parser/projection/wire validation. A singleton-only
      // host therefore cannot publish a declaration that no launcher can key.
      instancePolicy: (slot.instancePolicies as readonly PluginUiDestinationInstancePolicyV1[]).includes('multiple')
        ? PluginUiDestinationInstancePolicyV1Schema.default('singleton')
        : z.literal('singleton').default('singleton'),
      headerActions: slot.container === 'appPage'
        ? PluginUiViewHeaderActionsSchemaV2.appPage
        : PluginUiViewHeaderActionsSchemaV2.unsupported,
      ...(slot.targetKind === 'app'
        && (slot.container === 'appPage' || slot.container === 'rightSidebarTab')
        ? { placement: PluginUiDestinationPlacementV1Schema.optional() }
        : {}),
      ...(slot.container === 'appPage'
        ? { column: PluginUiAppPageColumnV1Schema.optional(), widgetAreas: PluginUiWidgetAreaDeclarationsV1Schema.optional() }
        : {}),
      container: z.literal(slot.container),
      target: PluginUiViewTargetSchemaByKindV1[slot.targetKind],
    }).strict());
  const inlineVariants = Object.values(PLUGIN_UI_INLINE_SURFACE_SLOTS_V1)
    .filter((slot) => isPluginUiAuthoredViewInlineSurfaceRoleV1(slot.role))
    .flatMap((slot) => Object.keys(slot.targets).map((targetKind) => {
      const common = {
      ...PluginUiViewInlineCommonShapeV2,
      container: z.literal(slot.role),
      target: PluginUiViewTargetSchemaByKindV1[targetKind as keyof typeof PluginUiViewTargetSchemaByKindV1],
      ...(slot.role === 'widget'
        ? { home: PluginUiWidgetHomeV1Schema.optional() }
        : {}),
      ...(slot.role === 'widget'
        ? { connectedAccountPurposeBindings: z.array(WidgetConnectedAccountPurposeBindingV1Schema).optional(),
            resources: z.array(asProtocolZod(PluginContributionIdentityV1Schema)).optional() }
        : {}),
      ...(slot.role === 'widget' && targetKind === 'session'
        ? { inputs: InputHintsSchema, inputSchema: PluginJsonSchemaV2Schema, sessionInputPath: InputPathSchema }
        : {}),
      };
      // Preserve the value-schema requirement in authoring JSON Schema too:
      // an App widget either has no inputs or declares inputs plus their schema.
      if (slot.role === 'widget' && targetKind === 'app') {
        return z.union([
          z.object({ ...common, inputs: z.never().optional(), inputSchema: PluginJsonSchemaV2Schema.optional() }).strict(),
          z.object({ ...common, inputs: InputHintsSchema, inputSchema: PluginJsonSchemaV2Schema }).strict(),
        ]);
      }
      return z.object(common).strict();
    }));
  const variants = [...destinationVariants, ...inlineVariants];
  const [first, second, ...remaining] = variants;
  if (!first || !second) {
    throw new Error('Plugin UI surface Registry must declare at least two ui.views binding slots.');
  }
  return z.union([first, second, ...remaining]);
}

const PluginUiViewV2SchemaRaw = createPluginUiViewBindingSchemaV2().superRefine((view, ctx) => {
  if (view.container === 'widget') {
    const inputs = 'inputs' in view ? InputHintsSchema.safeParse(view.inputs) : null;
    const inputSchema = 'inputSchema' in view ? PluginJsonSchemaV2Schema.safeParse(view.inputSchema) : null;
    const purposeBindings = 'connectedAccountPurposeBindings' in view
      ? z.array(WidgetConnectedAccountPurposeBindingV1Schema).safeParse(view.connectedAccountPurposeBindings ?? []) : null;
    if (purposeBindings?.success && (!hasValidPluginConnectedAccountPurposeBindingsV2(inputSchema?.success ? inputSchema.data : undefined, purposeBindings.data)
      || purposeBindings.data.some((binding) => !inputs?.success || !inputs.data.fields.some((field) => field.path === binding.path)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connectedAccountPurposeBindings'], message: 'Widget viewer purposes must bind exact declared Connected Account input fields.' });
    }
    const resources = 'resources' in view ? z.array(asProtocolZod(PluginContributionIdentityV1Schema)).safeParse(view.resources) : null;
    if (purposeBindings?.success && purposeBindings.data.some(binding => !resources?.success || !resources.data.some(resource =>
      resource.pluginId === binding.consumer.pluginId && resource.localId === binding.consumer.localId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connectedAccountPurposeBindings'], message: 'Widget purposes must name a declared read Resource consumer.' });
    }
    if ('sessionInputPath' in view && view.sessionInputPath !== undefined
      && (!inputs?.success || !inputs.data.fields.some((field) => field.path === view.sessionInputPath))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessionInputPath'], message: 'The exact Session path must name a declared widget input.' });
    }
  }
  const rendererChain = validatePluginUiRendererChainFieldsV1({
    renderer: view.renderer,
    fallbackRenderers: view.fallbackRenderers,
  });
  if (!rendererChain.success) {
    rendererChain.error.issues.forEach((issue) => ctx.addIssue({
      ...issue,
      path: issue.path,
    }));
  }
});

/**
 * `Array#map` necessarily widens the dynamic Zod union above: the mapped
 * element type collapses every slot's container, target, instance policy and
 * header-action capability into one object with union-typed fields. Keep its
 * full schema-derived shape, then intersect it with the correlated rows from
 * the same Registry tuple so public declaration input/output cannot form an
 * unadmitted cross-product. Every correlated field below is derived from the
 * same Registry row the parser and the generated authoring schema read, so the
 * three layers admit one grammar. The mapped registry relation is
 * deliberately inline: this exported author declaration must not name a
 * Protocol-private helper from SDK manifest and testkit signatures.
 */
export type PluginUiViewDestinationBindingInputV2 = {
  [TSlot in Exclude<
    typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number],
    Readonly<{ container: 'settingsPage' }>
  > as `${TSlot['container']}:${TSlot['targetKind']}`]: Readonly<{
    container: TSlot['container'];
    target: z.input<typeof PluginUiViewTargetSchemaByKindV1[TSlot['targetKind']]>;
    instancePolicy?: TSlot['instancePolicies'][number];
    headerActions?: TSlot['container'] extends 'appPage'
      ? PluginUiPageHeaderActionV1Input[]
      : [];
    placement?: TSlot['targetKind'] extends 'app'
      ? TSlot['container'] extends 'appPage' | 'rightSidebarTab'
        ? PluginUiDestinationPlacementV1
        : never
      : never;
    column?: TSlot['container'] extends 'appPage'
      ? PluginUiAppPageColumnV1
      : never;
    widgetAreas?: TSlot['container'] extends 'appPage' ? PluginUiWidgetAreaDeclarationV1[] : never;
  }>;
}[keyof {
  [TSlot in Exclude<
    typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number],
    Readonly<{ container: 'settingsPage' }>
  > as `${TSlot['container']}:${TSlot['targetKind']}`]: TSlot;
}];
type PluginUiViewInlineSlotV1 =
  typeof PLUGIN_UI_INLINE_SURFACE_SLOTS_V1[PluginUiAuthoredViewInlineSurfaceRoleV1];
export type PluginUiViewInlineBindingInputV2 = {
  [TSlot in PluginUiViewInlineSlotV1 as TSlot['role']]: {
    [TTarget in keyof TSlot['targets'] & keyof typeof PluginUiViewTargetSchemaByKindV1]: Readonly<{
      container: TSlot['role'];
      target: z.input<typeof PluginUiViewTargetSchemaByKindV1[TTarget]>;
      home?: TSlot['role'] extends 'widget' ? PluginUiWidgetHomeV1 : never;
      resources?: TSlot['role'] extends 'widget' ? PluginContributionIdentityV1[] : never;
    }> & (TSlot['role'] extends 'widget'
      ? TTarget extends 'session'
        ? Readonly<{ inputs: InputHints; inputSchema: PluginJsonSchemaV2; sessionInputPath: string; connectedAccountPurposeBindings?: WidgetConnectedAccountPurposeBindingV1[] }>
        : (Readonly<{ inputs?: never; inputSchema?: PluginJsonSchemaV2 }> | Readonly<{ inputs: InputHints; inputSchema: PluginJsonSchemaV2 }>)
          & Readonly<{ sessionInputPath?: never; connectedAccountPurposeBindings?: WidgetConnectedAccountPurposeBindingV1[] }>
      : Readonly<{ inputs?: never; inputSchema?: never; sessionInputPath?: never; connectedAccountPurposeBindings?: never }>);
  }[keyof TSlot['targets'] & keyof typeof PluginUiViewTargetSchemaByKindV1];
}[PluginUiViewInlineSlotV1['role']];
export type PluginUiViewV2Input = z.input<typeof PluginUiViewV2SchemaRaw>
  & (PluginUiViewDestinationBindingInputV2 | PluginUiViewInlineBindingInputV2);
export type PluginUiViewDestinationBindingV2 = z.output<typeof PluginUiViewV2SchemaRaw> & {
  [TSlot in Exclude<
    typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number],
    Readonly<{ container: 'settingsPage' }>
  > as `${TSlot['container']}:${TSlot['targetKind']}`]: Readonly<{
    container: TSlot['container'];
    target: z.output<typeof PluginUiViewTargetSchemaByKindV1[TSlot['targetKind']]>;
    instancePolicy: TSlot['instancePolicies'][number];
    headerActions: TSlot['container'] extends 'appPage'
      ? PluginUiPageHeaderActionV1[]
      : [];
    placement?: TSlot['targetKind'] extends 'app'
      ? TSlot['container'] extends 'appPage' | 'rightSidebarTab'
        ? PluginUiDestinationPlacementV1
        : never
      : never;
    column?: TSlot['container'] extends 'appPage'
      ? PluginUiAppPageColumnV1
      : never;
    widgetAreas?: TSlot['container'] extends 'appPage' ? PluginUiWidgetAreaDeclarationV1[] : never;
  }>;
}[keyof {
  [TSlot in Exclude<
    typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number],
    Readonly<{ container: 'settingsPage' }>
  > as `${TSlot['container']}:${TSlot['targetKind']}`]: TSlot;
}];
export type PluginUiViewInlineBindingV2 = {
  [TSlot in PluginUiViewInlineSlotV1 as TSlot['role']]: {
    [TTarget in keyof TSlot['targets'] & keyof typeof PluginUiViewTargetSchemaByKindV1]: Readonly<{
      container: TSlot['role'];
      target: z.output<typeof PluginUiViewTargetSchemaByKindV1[TTarget]>;
      home?: TSlot['role'] extends 'widget' ? PluginUiWidgetHomeV1 : never;
      resources?: TSlot['role'] extends 'widget' ? PluginContributionIdentityV1[] : never;
    }> & (TSlot['role'] extends 'widget'
      ? TTarget extends 'session'
        ? Readonly<{ inputs: InputHints; inputSchema: PluginJsonSchemaV2; sessionInputPath: string; connectedAccountPurposeBindings?: WidgetConnectedAccountPurposeBindingV1[] }>
        : (Readonly<{ inputs?: never; inputSchema?: PluginJsonSchemaV2 }> | Readonly<{ inputs: InputHints; inputSchema: PluginJsonSchemaV2 }>)
          & Readonly<{ sessionInputPath?: never; connectedAccountPurposeBindings?: WidgetConnectedAccountPurposeBindingV1[] }>
      : Readonly<{ inputs?: never; inputSchema?: never; sessionInputPath?: never; connectedAccountPurposeBindings?: never }>);
  }[keyof TSlot['targets'] & keyof typeof PluginUiViewTargetSchemaByKindV1];
}[PluginUiViewInlineSlotV1['role']];
export type PluginUiViewV2 = z.output<typeof PluginUiViewV2SchemaRaw> & (
  PluginUiViewDestinationBindingV2 | PluginUiViewInlineBindingV2
);
export const PluginUiViewV2Schema: z.ZodType<PluginUiViewV2, PluginUiViewV2Input> =
  PluginUiViewV2SchemaRaw as z.ZodType<PluginUiViewV2, PluginUiViewV2Input>;

export const PluginUiSettingsHostGroupIdV1Schema = lazyZodSchema(() => z.enum([
  'general',
  'aiAndAgents',
  'sessionsBehavior',
  'filesAndSourceControl',
  'system',
]));
export type PluginUiSettingsHostGroupIdV1 =
  z.infer<typeof PluginUiSettingsHostGroupIdV1Schema>;

export const PluginUiSettingsGroupReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host'), id: PluginUiSettingsHostGroupIdV1Schema }).strict(),
  z.object({ kind: z.literal('plugin'), localId: asProtocolZod(PluginContributionLocalIdSchema) }).strict(),
]));
export type PluginUiSettingsGroupReferenceV1 =
  z.infer<typeof PluginUiSettingsGroupReferenceV1Schema>;

export const MAX_PLUGIN_UI_SETTINGS_KEYWORDS_V1 = 16;
export const MAX_PLUGIN_UI_SETTINGS_KEYWORD_UTF8_BYTES_V1 = 64;
export const MAX_PLUGIN_UI_SETTINGS_TITLE_UTF8_BYTES_V1 = 160;
export const MAX_PLUGIN_UI_SETTINGS_SUBTITLE_UTF8_BYTES_V1 = 280;
export const MIN_PLUGIN_UI_SETTINGS_DEFAULT_RANK_V1 = -10_000;
export const MAX_PLUGIN_UI_SETTINGS_DEFAULT_RANK_V1 = 10_000;

const PluginUiSettingsTitleV1Schema = createBoundedLocalizedStringSchema(
  MAX_PLUGIN_UI_SETTINGS_TITLE_UTF8_BYTES_V1,
  'Plugin Settings title',
);
const PluginUiSettingsSubtitleV1Schema = lazyZodSchema(() => createBoundedLocalizedStringSchema(
  MAX_PLUGIN_UI_SETTINGS_SUBTITLE_UTF8_BYTES_V1,
  'Plugin Settings subtitle',
));
const PluginUiSettingsDefaultRankV1Schema = lazyZodSchema(() => z.number().int().min(
  MIN_PLUGIN_UI_SETTINGS_DEFAULT_RANK_V1,
).max(MAX_PLUGIN_UI_SETTINGS_DEFAULT_RANK_V1).optional());

/** A local plugin-qualified Settings group; empty groups are filtered by the host catalog. */
export const PluginUiSettingsGroupV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginUiSettingsTitleV1Schema,
  icon: PluginUiIconTokenV1Schema.optional(),
  defaultRank: PluginUiSettingsDefaultRankV1Schema,
}).strict());
export type PluginUiSettingsGroupV1 = z.infer<typeof PluginUiSettingsGroupV1Schema>;

/**
 * One real Settings destination. It deliberately has no route, target, host
 * group eligibility result, or availability assertion: the Registry derives its
 * fixed `settingsPage × app` binding and the Settings catalog owns those facts.
 */
export const PluginUiSettingsPageV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  group: PluginUiSettingsGroupReferenceV1Schema,
  title: PluginUiSettingsTitleV1Schema,
  subtitle: PluginUiSettingsSubtitleV1Schema.optional(),
  keywords: z.array(
    z.string().trim().min(1).refine(
      (value) => isWithinUtf8ByteLimit(value, MAX_PLUGIN_UI_SETTINGS_KEYWORD_UTF8_BYTES_V1),
      `Plugin Settings keyword exceeds the ${MAX_PLUGIN_UI_SETTINGS_KEYWORD_UTF8_BYTES_V1}-byte UTF-8 limit.`,
    ),
  ).max(MAX_PLUGIN_UI_SETTINGS_KEYWORDS_V1).optional(),
  icon: PluginUiIconTokenV1Schema.optional(),
  defaultRank: PluginUiSettingsDefaultRankV1Schema,
  renderer: asProtocolZod(PluginContributionLocalIdSchema),
}).strict());
export type PluginUiSettingsPageV1 = z.infer<typeof PluginUiSettingsPageV1Schema>;

export const PluginUiTranslationBundleV2Schema = lazyZodSchema(() => z.object({
  locale: z.string().min(2).refine((value) => {
    try { return Intl.getCanonicalLocales(value)[0] === value; } catch { return false; }
  }, 'Locale must be a canonical BCP 47 language tag.'),
  messages: z.record(z.string(), z.string()),
}).strict());
export type PluginUiTranslationBundleV2 = z.infer<typeof PluginUiTranslationBundleV2Schema>;
export const PluginUiContributionsV2Schema = lazyZodSchema(() => z.object({
  views: z.array(PluginUiViewV2Schema).default([]),
  renderers: z.array(PluginUiRendererV2Schema).default([]),
  settingsGroups: z.array(PluginUiSettingsGroupV1Schema).default([]),
  settingsPages: z.array(PluginUiSettingsPageV1Schema).default([]),
  translations: z.array(PluginUiTranslationBundleV2Schema).default([]),
}).strict().superRefine((value, ctx) => {
  // Contribution ids and cross-contribution references are owned by manifest
  // ingestion through the contribution catalog, which is the single owner of
  // the plugin-wide id namespace and of dangling vs wrong-family references.
  // Translation locales are outside that namespace and stay unique here.
  const seen = new Set<string>();
  value.translations.forEach((translation, index) => {
    if (seen.has(translation.locale)) ctx.addIssue({ code: 'custom', path: ['translations', index, 'locale'], message: 'Duplicate translation locale.' });
    seen.add(translation.locale);
  });
}).default({ views: [], renderers: [], settingsGroups: [], settingsPages: [], translations: [] }));
export type PluginUiContributionsV2 = z.infer<typeof PluginUiContributionsV2Schema>;
