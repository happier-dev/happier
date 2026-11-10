import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { PluginDeclarativeMetricNodeV1Schema, PluginDeclarativeTableNodeV1Schema, PluginDeclarativeRowsNodeV1Schema, PluginDeclarativeChartNodeV1Schema, type PluginDeclarativeDataNodeV1 } from './declarativeDataV1.js';
import { ActionIdSchema, type ActionId } from '../../../actions/actionIds.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';

import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../../contributionIdentity.js';
import { PluginIdSchema } from '../../pluginId.js';
import {
  NormalizedPluginCollectionUiQueryDescriptorV1Schema,
  type NormalizedPluginCollectionUiQueryDescriptorV1,
} from '../../data/collectionUiQueryWireV1.js';
import { PluginUiInstanceKeyV1Schema, type PluginUiInstanceKeyV1 } from '../../ui/semanticCommands.js';
import {
  PluginUiHostMethodV1Schema,
  type PluginUiHostMethodV1,
} from '../../ui/hostApiDefinition.js';
import {
  PluginUiTargetedContributionSurfaceV1Schema,
  type PluginUiTargetedContributionSurfaceV1,
} from '../../ui/targetedContributions.js';
import {
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
  PluginLocalizedMarkdownV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
  type PluginLocalizedStringV2,
} from '../publicTypes.js';
import { PluginSettingFieldIdV2Schema } from '../settings.js';
import {
  MAX_PLUGIN_DECLARATIVE_METADATA_ENTRIES_V2,
  PluginDeclarativeActionVariantV2Schema,
  PluginDeclarativeCollectionListProjectionV1Schema,
  PluginDeclarativeCollectionListSourceV1Schema,
  PluginDeclarativeComposerApplyEffectV1Schema,
  PluginDeclarativeControlV2Schema,
  PluginDeclarativeMetadataEntryV2Schema,
  PluginDeclarativeStateV2Schema,
  PluginDeclarativeToneV2Schema,
  type PluginDeclarativeActionVariantV2,
  type PluginDeclarativeCollectionListProjectionV1,
  type PluginDeclarativeCollectionListSourceV1,
  type PluginDeclarativeComposerApplyEffectV1,
  type PluginDeclarativeControlV2,
  type PluginDeclarativeMetadataEntryV2,
  type PluginDeclarativeStateV2,
  type PluginDeclarativeToneV2,
} from './v2.js';
import {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_OCCURRENCE_LENGTH_V1,
  PluginDeclarativeSettingsInventoryEntryV1Schema,
} from './declarativeDocument.js';
import { PluginUiIconTokenV1Schema, type PluginUiIconTokenV1 } from './tokens.js';

/** The canonical identity schema is composable; plain zod objects consume this zod projection. */
const PluginContributionIdentityV1ZodSchema = asProtocolZod(PluginContributionIdentityV1Schema);

/**
 * The final projected declarative model — the CLI-enriched evaluation of one
 * admitted declarative renderer after Protocol normalization plus host-owned
 * runtime enrichment (live Action availability, Settings reattachment,
 * deterministic paths/order). This is the one strict wire contract for that
 * projection: the CLI producer emits it, the daemon contribution-registry
 * projection validates it at the wire, and the physical UI host parses it
 * instead of re-deriving structural admission from opaque records. It is
 * `closed`: the model carries qualified identity references and availability
 * decisions, so unknown fields are rejected rather than preserved. Relational
 * scope/currentness checks (same-plugin inventories, mount occurrenceId match,
 * byte-equal Settings reattachment) remain at the consumers owning those
 * lifetimes.
 *
 * Reuses the exact Protocol declarative vocabulary schemas; only the host
 * projection additions (path/order, enabled, reattached Settings field,
 * inventory, envelope) are declared here.
 */

export type PluginDeclarativeProjectedQualifiedReferenceV1 = Readonly<{
  identity: {
    pluginId: string;
    localId: string;
  };
  qualifiedId: string;
  occurrenceId?: string;
}>;

export const PluginDeclarativeProjectedQualifiedReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  identity: PluginContributionIdentityV1ZodSchema,
  qualifiedId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
  occurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PLUGIN_DECLARATIVE_DOCUMENT_OCCURRENCE_LENGTH_V1))),
}));

export type PluginDeclarativeProjectedActionBindingV1 =
  PluginDeclarativeProjectedQualifiedReferenceV1 & Readonly<{
    enabled: boolean;
    /** Current Action-catalog presentation; absent actions cannot become row affordances. */
    title?: string;
    icon?: string;
  }>;

export const PluginDeclarativeProjectedActionBindingV1Schema =
  lazyZodSchema(() => z.extend(PluginDeclarativeProjectedQualifiedReferenceV1Schema, {
    enabled: z.boolean(),
    title: z.optional(z.string().check(z.trim(), z.minLength(1))),
    icon: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }));

/**
 * The exact existing Settings projection reattached for the UI renderer. The
 * envelope mirrors the host-owned Settings field; Protocol validates structure
 * only and never reads or writes a Settings record.
 */
export type PluginDeclarativeProjectedSettingsFieldV1 = Readonly<{
  id: string;
  contributionId: string;
  qualifiedId: string;
  descriptor: Readonly<{
    id: string;
    title: string;
    description?: string;
    target: Readonly<{ kind: 'plugin' }> | Readonly<{ kind: 'agent'; agent: { pluginId: string; localId: string } }>;
    scope: 'account' | 'daemon';
    schema: PluginJsonSchemaV2;
    readOnly?: boolean;
    /** The secret/default cross-constraint is enforced by the schema's superRefine. */
    secret?: boolean;
    default?: PluginJsonValueV2;
  }>;
}>;

export const PluginDeclarativeProjectedSettingsFieldV1Schema = lazyZodSchema(() => z.strictObject({
  id: PluginSettingFieldIdV2Schema,
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  qualifiedId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
  descriptor: z.strictObject({
    id: PluginSettingFieldIdV2Schema,
    title: z.string().check(z.trim(), z.minLength(1)),
    description: z.optional(z.string().check(z.trim(), z.minLength(1))),
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('plugin') }),
      z.strictObject({ kind: z.literal('agent'), agent: PluginContributionIdentityV1ZodSchema }),
    ]),
    scope: z.enum(['account', 'daemon']),
    schema: PluginJsonSchemaV2Schema,
    readOnly: z.optional(z.boolean()),
    secret: z.optional(z.boolean()),
    default: z.optional(PluginJsonValueV2Schema),
  }).check(z.superRefine((value, context) => {
    if (value.secret === true && value.default !== undefined) {
      context.addIssue({
        code: "custom",
        path: ['default'],
        message: 'A secret setting descriptor cannot declare a default value.',
      });
    }
  })),
}));

export type PluginDeclarativeProjectedSettingsBindingV1 =
  Readonly<{
    pluginId: string;
    id: string;
    qualifiedId: string;
    schema: PluginJsonSchemaV2;
    secret: boolean;
    setting: PluginDeclarativeProjectedSettingsFieldV1;
  }>;

export const PluginDeclarativeProjectedSettingsBindingV1Schema =
  lazyZodSchema(() => z.extend(PluginDeclarativeSettingsInventoryEntryV1Schema, {
    setting: PluginDeclarativeProjectedSettingsFieldV1Schema,
  }));

export type PluginDeclarativeProjectedCollectionRowCommandV1 =
  | Readonly<{ kind: 'action'; action: PluginDeclarativeProjectedQualifiedReferenceV1 }>
  | Readonly<{ kind: 'openSurface'; destination: PluginDeclarativeProjectedQualifiedReferenceV1 }>;

export const PluginDeclarativeProjectedCollectionRowCommandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('action'),
    action: PluginDeclarativeProjectedQualifiedReferenceV1Schema,
  }),
  z.strictObject({
    kind: z.literal('openSurface'),
    destination: PluginDeclarativeProjectedQualifiedReferenceV1Schema,
  }),
]));

export type PluginDeclarativeProjectedStateNodeV1 = Readonly<{
  kind: 'state';
  path: string;
  order: number;
  state: PluginDeclarativeStateV2;
  title: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  icon?: PluginUiIconTokenV1;
}>;

const ProjectedNodeBaseV1Shape = {
  path: z.string().check(z.trim(), z.minLength(1)),
  order: z.number().check(z.int(), z.nonnegative()),
} as const;

export const PluginDeclarativeProjectedStateNodeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('state'),
  ...ProjectedNodeBaseV1Shape,
  state: PluginDeclarativeStateV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  icon: z.optional(PluginUiIconTokenV1Schema),
}));

/**
 * The projected node tree. Protocol already normalized, bounded, and qualified
 * the authored document; this union adds only the host projection facts.
 * Children keep the full projected union: re-narrowing per container here
 * would duplicate the authoring grammar as a second decision-maker.
 */
export type PluginDeclarativeProjectedNodeV1 =
  | (PluginDeclarativeDataNodeV1 & Readonly<{ path: string; order: number }>)
  | Readonly<{ kind: 'dragSource'; path: string; order: number; source: PluginDeclarativeProjectedQualifiedReferenceV1; reference: PluginJsonValueV2; organizing?: boolean; children: readonly PluginDeclarativeProjectedNodeV1[] }>
  | Readonly<{ kind: 'dropTarget'; path: string; order: number; target: PluginDeclarativeProjectedQualifiedReferenceV1; input?: PluginJsonValueV2; children: readonly PluginDeclarativeProjectedNodeV1[] }>
  | Readonly<{ kind: 'widgetArea'; path: string; order: number; area: string; context?: Readonly<Record<string, PluginJsonValueV2>> }>
  | Readonly<{ kind: 'text'; path: string; order: number; text: PluginLocalizedStringV2; tone?: PluginDeclarativeToneV2 }>
  | Readonly<{ kind: 'markdown'; path: string; order: number; text: PluginLocalizedStringV2 }>
  | Readonly<{
    kind: 'stack';
    path: string;
    order: number;
    direction?: 'vertical' | 'horizontal';
    gap?: 'small' | 'medium' | 'large';
    children: readonly PluginDeclarativeProjectedNodeV1[];
  }>
  | Readonly<{
    kind: 'group';
    path: string;
    order: number;
    title?: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeProjectedNodeV1[];
  }>
  | Readonly<{
    kind: 'field';
    path: string;
    order: number;
    label: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    control: PluginDeclarativeControlV2;
    setting: PluginDeclarativeProjectedSettingsFieldV1;
  }>
  | Readonly<{
    kind: 'status';
    path: string;
    order: number;
    label: PluginLocalizedStringV2;
    value: PluginLocalizedStringV2;
    tone?: PluginDeclarativeToneV2;
  }>
  | Readonly<{
    kind: 'action';
    path: string;
    order: number;
    label: PluginLocalizedStringV2;
    variant?: PluginDeclarativeActionVariantV2;
    action?: PluginDeclarativeProjectedQualifiedReferenceV1;
    effect?: PluginDeclarativeComposerApplyEffectV1;
    hostAction?: ActionId;
    input?: PluginJsonValueV2;
    enabled: boolean;
  }>
  | Readonly<{
    kind: 'collectionList';
    path: string;
    order: number;
    label?: PluginLocalizedStringV2;
    source: PluginDeclarativeCollectionListSourceV1;
    /** The exact Data-normalized descriptor from the admitted inventory. */
    query: NormalizedPluginCollectionUiQueryDescriptorV1;
    projection: PluginDeclarativeCollectionListProjectionV1;
    primaryCommand?: PluginDeclarativeProjectedCollectionRowCommandV1;
    secondaryCommands?: readonly PluginDeclarativeProjectedCollectionRowCommandV1[];
  }>
  | Readonly<{
    kind: 'list';
    path: string;
    order: number;
    label?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeProjectedNodeV1[];
  }>
  | Readonly<{
    kind: 'section';
    path: string;
    order: number;
    title?: PluginLocalizedStringV2;
    footer?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeProjectedNodeV1[];
  }>
  | Readonly<{
    kind: 'item';
    path: string;
    order: number;
    title: PluginLocalizedStringV2;
    subtitle?: PluginLocalizedStringV2;
    detail?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    tone?: PluginDeclarativeToneV2;
    /** Present together with `enabled`, or absent — a row is interactive only when both hold. */
    action?: PluginDeclarativeProjectedQualifiedReferenceV1;
    input?: PluginJsonValueV2;
    enabled?: boolean;
  }>
  | PluginDeclarativeProjectedStateNodeV1
  | Readonly<{
    kind: 'targetedSurface';
    path: string;
    order: number;
    surface: PluginUiTargetedContributionSurfaceV1;
    input: PluginJsonValueV2;
    /** Host-namespaced opaque mount identity, never the author raw key. */
    instanceKey: PluginUiInstanceKeyV1;
    fallback?: PluginDeclarativeProjectedStateNodeV1;
  }>
  | Readonly<{
    kind: 'metadata';
    path: string;
    order: number;
    title?: PluginLocalizedStringV2;
    entries: readonly PluginDeclarativeMetadataEntryV2[];
  }>
  | Readonly<{
    kind: 'actionPanel';
    path: string;
    order: number;
    title?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeProjectedNodeV1[];
  }>;

export const PluginDeclarativeProjectedNodeV1Schema: z.ZodMiniType<PluginDeclarativeProjectedNodeV1> = z.lazy(
  () => z.union([z.union(PluginDeclarativeChartNodeV1Schema._zod.def.options.map(schema => z.extend(schema, ProjectedNodeBaseV1Shape))), z.discriminatedUnion('kind', [
    lazyZodSchema(() => z.extend(PluginDeclarativeMetricNodeV1Schema, ProjectedNodeBaseV1Shape)),
    lazyZodSchema(() => z.extend(PluginDeclarativeTableNodeV1Schema, ProjectedNodeBaseV1Shape)),
    lazyZodSchema(() => z.extend(PluginDeclarativeRowsNodeV1Schema, ProjectedNodeBaseV1Shape)),
    z.strictObject({ kind: z.literal('dragSource'), ...ProjectedNodeBaseV1Shape, source: PluginDeclarativeProjectedQualifiedReferenceV1Schema, reference: PluginJsonValueV2Schema, organizing: z.optional(z.boolean()), children: z.array(PluginDeclarativeProjectedNodeV1Schema) }),
    z.strictObject({ kind: z.literal('dropTarget'), ...ProjectedNodeBaseV1Shape, target: PluginDeclarativeProjectedQualifiedReferenceV1Schema, input: z.optional(PluginJsonValueV2Schema), children: z.array(PluginDeclarativeProjectedNodeV1Schema) }),
    z.strictObject({ kind: z.literal('widgetArea'), ...ProjectedNodeBaseV1Shape, area: z.string().check(z.trim(), z.minLength(1)), context: z.optional(z.record(z.string(), PluginJsonValueV2Schema)) }),
    z.strictObject({ kind: z.literal('text'), ...ProjectedNodeBaseV1Shape, text: PluginLocalizedStringV2Schema, tone: z.optional(PluginDeclarativeToneV2Schema) }),
    z.strictObject({ kind: z.literal('markdown'), ...ProjectedNodeBaseV1Shape, text: PluginLocalizedMarkdownV2Schema }),
    z.strictObject({
      kind: z.literal('stack'),
      ...ProjectedNodeBaseV1Shape,
      direction: z.optional(z.enum(['vertical', 'horizontal'])),
      gap: z.optional(z.enum(['small', 'medium', 'large'])),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }),
    z.strictObject({
      kind: z.literal('group'),
      ...ProjectedNodeBaseV1Shape,
      title: z.optional(PluginLocalizedStringV2Schema),
      description: z.optional(PluginLocalizedStringV2Schema),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }),
    z.strictObject({
      kind: z.literal('field'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema,
      description: z.optional(PluginLocalizedStringV2Schema),
      control: PluginDeclarativeControlV2Schema,
      setting: PluginDeclarativeProjectedSettingsFieldV1Schema,
    }),
    z.strictObject({
      kind: z.literal('status'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema,
      value: PluginLocalizedStringV2Schema,
      tone: z.optional(PluginDeclarativeToneV2Schema),
    }),
    z.strictObject({
      kind: z.literal('action'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema,
      variant: z.optional(PluginDeclarativeActionVariantV2Schema),
      action: z.optional(PluginDeclarativeProjectedQualifiedReferenceV1Schema),
      effect: z.optional(PluginDeclarativeComposerApplyEffectV1Schema),
      hostAction: z.optional(ActionIdSchema),
      input: z.optional(PluginJsonValueV2Schema),
      enabled: z.boolean(),
    }).check(z.superRefine((node, context) => {
      if ([node.action, node.hostAction, node.effect].filter((value) => value !== undefined).length !== 1) {
        context.addIssue({
          code: "custom",
          path: ['action'],
          message: 'A projected action must name exactly one contributed Action, host Action, or effect.',
        });
      }
      if (node.effect !== undefined && node.input !== undefined) {
        context.addIssue({
          code: "custom",
          path: ['input'],
          message: 'A projected composerApply effect cannot carry Action input.',
        });
      }
    })),
    z.strictObject({
      kind: z.literal('collectionList'),
      ...ProjectedNodeBaseV1Shape,
      label: z.optional(PluginLocalizedStringV2Schema),
      source: PluginDeclarativeCollectionListSourceV1Schema,
      query: NormalizedPluginCollectionUiQueryDescriptorV1Schema,
      projection: PluginDeclarativeCollectionListProjectionV1Schema,
      primaryCommand: z.optional(PluginDeclarativeProjectedCollectionRowCommandV1Schema),
      secondaryCommands: z.optional(z.array(PluginDeclarativeProjectedCollectionRowCommandV1Schema)),
    }),
    z.strictObject({
      kind: z.literal('list'),
      ...ProjectedNodeBaseV1Shape,
      label: z.optional(PluginLocalizedStringV2Schema),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }),
    z.strictObject({
      kind: z.literal('section'),
      ...ProjectedNodeBaseV1Shape,
      title: z.optional(PluginLocalizedStringV2Schema),
      footer: z.optional(PluginLocalizedStringV2Schema),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }),
    z.strictObject({
      kind: z.literal('item'),
      ...ProjectedNodeBaseV1Shape,
      title: PluginLocalizedStringV2Schema,
      subtitle: z.optional(PluginLocalizedStringV2Schema),
      detail: z.optional(PluginLocalizedStringV2Schema),
      icon: z.optional(PluginUiIconTokenV1Schema),
      tone: z.optional(PluginDeclarativeToneV2Schema),
      action: z.optional(PluginDeclarativeProjectedQualifiedReferenceV1Schema),
      input: z.optional(PluginJsonValueV2Schema),
      enabled: z.optional(z.boolean()),
    }).check(z.superRefine((node, context) => {
      if (node.action === undefined && (node.input !== undefined || node.enabled !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ['action'],
          message: 'A projected item carries input/enabled only together with an Action.',
        });
      }
    })),
    PluginDeclarativeProjectedStateNodeV1Schema,
    z.strictObject({
      kind: z.literal('targetedSurface'),
      ...ProjectedNodeBaseV1Shape,
      surface: PluginUiTargetedContributionSurfaceV1Schema,
      input: PluginJsonValueV2Schema,
      instanceKey: PluginUiInstanceKeyV1Schema,
      fallback: z.optional(PluginDeclarativeProjectedStateNodeV1Schema),
    }),
    z.strictObject({
      kind: z.literal('metadata'),
      ...ProjectedNodeBaseV1Shape,
      title: z.optional(PluginLocalizedStringV2Schema),
      entries: z.array(PluginDeclarativeMetadataEntryV2Schema).check(z.minLength(1), z.maxLength(MAX_PLUGIN_DECLARATIVE_METADATA_ENTRIES_V2)),
    }),
    z.strictObject({
      kind: z.literal('actionPanel'),
      ...ProjectedNodeBaseV1Shape,
      title: z.optional(PluginLocalizedStringV2Schema),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }),
  ])]),
);

export type PluginDeclarativeProjectedModelV1 = Readonly<{
  identity: Readonly<{
    pluginId: string;
    localId: string;
    qualifiedId: string;
    occurrenceId?: string;
  }>;
  visible: boolean;
  requiredHostMethods: readonly PluginUiHostMethodV1[];
  declarativeInventory: Readonly<{
    actions: readonly PluginDeclarativeProjectedActionBindingV1[];
    destinations: readonly PluginDeclarativeProjectedQualifiedReferenceV1[];
    settings: readonly PluginDeclarativeProjectedSettingsBindingV1[];
    uiQueries: readonly NormalizedPluginCollectionUiQueryDescriptorV1[];
    dragSources?: readonly (PluginDeclarativeProjectedQualifiedReferenceV1 & Readonly<{ referenceSchema: PluginJsonSchemaV2 }>)[];
    dropTargets?: readonly PluginDeclarativeProjectedQualifiedReferenceV1[];
  }>;
  root: PluginDeclarativeProjectedNodeV1;
}>;

/**
 * Declaration comparison only. Generated occurrence stamps and effect availability
 * differ between installed presentation and a serving runtime; authored values
 * (including identically named keys inside input/data) and targeted handles do not.
 * The result is not an admitted renderable model or effect authority.
 */
export function projectPluginDeclarativeModelComparisonV1(
  model: PluginDeclarativeProjectedModelV1,
): Readonly<Record<string, unknown>> {
  const withoutOccurrence = <T extends Readonly<{ occurrenceId?: string }>>(value: T) => {
    const { occurrenceId: _occurrenceId, ...content } = value;
    return content;
  };
  const commandContent = (command: PluginDeclarativeProjectedCollectionRowCommandV1): PluginDeclarativeProjectedCollectionRowCommandV1 => (
    command.kind === 'action'
      ? { ...command, action: withoutOccurrence(command.action) }
      : { ...command, destination: withoutOccurrence(command.destination) }
  );
  const nodeContent = (node: PluginDeclarativeProjectedNodeV1): PluginDeclarativeProjectedNodeV1 => {
    switch (node.kind) {
      case 'stack':
      case 'group':
      case 'list':
      case 'section':
      case 'actionPanel':
        return { ...node, children: node.children.map(nodeContent) };
      case 'dragSource':
        return { ...node, source: withoutOccurrence(node.source), children: node.children.map(nodeContent) };
      case 'dropTarget':
        return { ...node, target: withoutOccurrence(node.target), children: node.children.map(nodeContent) };
      case 'action':
        return { ...node, ...(node.action ? { action: withoutOccurrence(node.action) } : {}), enabled: false };
      case 'item':
        return node.action ? { ...node, action: withoutOccurrence(node.action), enabled: false } : node;
      case 'collectionList':
        return {
          ...node,
          ...(node.primaryCommand ? { primaryCommand: commandContent(node.primaryCommand) } : {}),
          ...(node.secondaryCommands ? { secondaryCommands: node.secondaryCommands.map(commandContent) } : {}),
        };
      case 'metric':
      case 'table':
      case 'rows':
      case 'chart':
      case 'widgetArea':
      case 'text':
      case 'markdown':
      case 'field':
      case 'status':
      case 'state':
      case 'targetedSurface':
      case 'metadata':
        return node;
      default:
        return node satisfies never;
    }
  };
  return {
    ...model,
    identity: withoutOccurrence(model.identity),
    declarativeInventory: {
      ...model.declarativeInventory,
      actions: model.declarativeInventory.actions.map((action) => ({ ...withoutOccurrence(action), enabled: false })),
      destinations: model.declarativeInventory.destinations.map(withoutOccurrence),
      ...(model.declarativeInventory.dragSources ? { dragSources: model.declarativeInventory.dragSources.map(withoutOccurrence) } : {}),
      ...(model.declarativeInventory.dropTargets ? { dropTargets: model.declarativeInventory.dropTargets.map(withoutOccurrence) } : {}),
    },
    root: nodeContent(model.root),
  };
}

export const PluginDeclarativeProjectedModelV1Schema: z.ZodMiniType<PluginDeclarativeProjectedModelV1> =
  lazyZodSchema(() => z.strictObject({
    identity: z.strictObject({
      pluginId: asProtocolZod(PluginIdSchema),
      localId: asProtocolZod(PluginContributionLocalIdSchema),
      qualifiedId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
      occurrenceId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PLUGIN_DECLARATIVE_DOCUMENT_OCCURRENCE_LENGTH_V1))),
    }),
    visible: z.boolean(),
    requiredHostMethods: z.array(PluginUiHostMethodV1Schema),
    declarativeInventory: z.strictObject({
      actions: z.array(PluginDeclarativeProjectedActionBindingV1Schema),
      destinations: z.array(PluginDeclarativeProjectedQualifiedReferenceV1Schema),
      settings: z.array(PluginDeclarativeProjectedSettingsBindingV1Schema),
      uiQueries: z.array(NormalizedPluginCollectionUiQueryDescriptorV1Schema),
      dragSources: z.optional(z.array(z.extend(PluginDeclarativeProjectedQualifiedReferenceV1Schema, { referenceSchema: PluginJsonSchemaV2Schema }))),
      dropTargets: z.optional(z.array(PluginDeclarativeProjectedQualifiedReferenceV1Schema)),
    }),
    root: PluginDeclarativeProjectedNodeV1Schema,
  }).check(z.superRefine((model, context) => {
    if (model.identity.occurrenceId !== undefined) return;
    const pending: PluginDeclarativeProjectedNodeV1[] = [model.root];
    let hasLiveEffect = model.declarativeInventory.actions.some((action) => action.enabled);
    while (!hasLiveEffect && pending.length > 0) {
      const node = pending.pop();
      if (!node) break;
      hasLiveEffect = ((node.kind === 'action' || node.kind === 'item') && node.enabled === true)
        || node.kind === 'targetedSurface';
      if ('children' in node) pending.push(...node.children);
    }
    if (hasLiveEffect) context.addIssue({
      code: "custom",
      message: 'A declarative presentation without a runtime occurrence cannot enable effects or embed a current targeted Surface.',
    });
  })));
