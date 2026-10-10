import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
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

export const PluginDeclarativeProjectedQualifiedReferenceV1Schema = lazyZodSchema(() => z.object({
  identity: PluginContributionIdentityV1ZodSchema,
  qualifiedId: z.string().trim().min(1).max(1_024),
  occurrenceId: z.string().trim().min(1).max(MAX_PLUGIN_DECLARATIVE_DOCUMENT_OCCURRENCE_LENGTH_V1).optional(),
}).strict());

export type PluginDeclarativeProjectedActionBindingV1 =
  PluginDeclarativeProjectedQualifiedReferenceV1 & Readonly<{
    enabled: boolean;
    /** Current Action-catalog presentation; absent actions cannot become row affordances. */
    title?: string;
    icon?: string;
  }>;

export const PluginDeclarativeProjectedActionBindingV1Schema =
  lazyZodSchema(() => PluginDeclarativeProjectedQualifiedReferenceV1Schema.extend({
    enabled: z.boolean(),
    title: z.string().trim().min(1).optional(),
    icon: z.string().trim().min(1).optional(),
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

export const PluginDeclarativeProjectedSettingsFieldV1Schema = lazyZodSchema(() => z.object({
  id: PluginSettingFieldIdV2Schema,
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  qualifiedId: z.string().trim().min(1).max(1_024),
  descriptor: z.object({
    id: PluginSettingFieldIdV2Schema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('plugin') }).strict(),
      z.object({ kind: z.literal('agent'), agent: PluginContributionIdentityV1ZodSchema }).strict(),
    ]),
    scope: z.enum(['account', 'daemon']),
    schema: PluginJsonSchemaV2Schema,
    readOnly: z.boolean().optional(),
    secret: z.boolean().optional(),
    default: PluginJsonValueV2Schema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.secret === true && value.default !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: 'A secret setting descriptor cannot declare a default value.',
      });
    }
  }),
}).strict());

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
  lazyZodSchema(() => PluginDeclarativeSettingsInventoryEntryV1Schema.extend({
    setting: PluginDeclarativeProjectedSettingsFieldV1Schema,
  }));

export type PluginDeclarativeProjectedCollectionRowCommandV1 =
  | Readonly<{ kind: 'action'; action: PluginDeclarativeProjectedQualifiedReferenceV1 }>
  | Readonly<{ kind: 'openSurface'; destination: PluginDeclarativeProjectedQualifiedReferenceV1 }>;

export const PluginDeclarativeProjectedCollectionRowCommandV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    action: PluginDeclarativeProjectedQualifiedReferenceV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('openSurface'),
    destination: PluginDeclarativeProjectedQualifiedReferenceV1Schema,
  }).strict(),
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
  path: z.string().trim().min(1),
  order: z.number().int().nonnegative(),
} as const;

export const PluginDeclarativeProjectedStateNodeV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('state'),
  ...ProjectedNodeBaseV1Shape,
  state: PluginDeclarativeStateV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  icon: PluginUiIconTokenV1Schema.optional(),
}).strict());

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

export const PluginDeclarativeProjectedNodeV1Schema: z.ZodType<PluginDeclarativeProjectedNodeV1> = z.lazy(
  () => z.discriminatedUnion('kind', [
    PluginDeclarativeMetricNodeV1Schema.extend(ProjectedNodeBaseV1Shape),
    PluginDeclarativeTableNodeV1Schema.extend(ProjectedNodeBaseV1Shape),
    PluginDeclarativeRowsNodeV1Schema.extend(ProjectedNodeBaseV1Shape),
    PluginDeclarativeChartNodeV1Schema.extend(ProjectedNodeBaseV1Shape),
    z.object({ kind: z.literal('dragSource'), ...ProjectedNodeBaseV1Shape, source: PluginDeclarativeProjectedQualifiedReferenceV1Schema, reference: PluginJsonValueV2Schema, organizing: z.boolean().optional(), children: z.array(PluginDeclarativeProjectedNodeV1Schema) }).strict(),
    z.object({ kind: z.literal('dropTarget'), ...ProjectedNodeBaseV1Shape, target: PluginDeclarativeProjectedQualifiedReferenceV1Schema, input: PluginJsonValueV2Schema.optional(), children: z.array(PluginDeclarativeProjectedNodeV1Schema) }).strict(),
    z.object({ kind: z.literal('widgetArea'), ...ProjectedNodeBaseV1Shape, area: z.string().trim().min(1), context: z.record(z.string(), PluginJsonValueV2Schema).optional() }).strict(),
    z.object({ kind: z.literal('text'), ...ProjectedNodeBaseV1Shape, text: PluginLocalizedStringV2Schema, tone: PluginDeclarativeToneV2Schema.optional() }).strict(),
    z.object({ kind: z.literal('markdown'), ...ProjectedNodeBaseV1Shape, text: PluginLocalizedMarkdownV2Schema }).strict(),
    z.object({
      kind: z.literal('stack'),
      ...ProjectedNodeBaseV1Shape,
      direction: z.enum(['vertical', 'horizontal']).optional(),
      gap: z.enum(['small', 'medium', 'large']).optional(),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }).strict(),
    z.object({
      kind: z.literal('group'),
      ...ProjectedNodeBaseV1Shape,
      title: PluginLocalizedStringV2Schema.optional(),
      description: PluginLocalizedStringV2Schema.optional(),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }).strict(),
    z.object({
      kind: z.literal('field'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema,
      description: PluginLocalizedStringV2Schema.optional(),
      control: PluginDeclarativeControlV2Schema,
      setting: PluginDeclarativeProjectedSettingsFieldV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('status'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema,
      value: PluginLocalizedStringV2Schema,
      tone: PluginDeclarativeToneV2Schema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('action'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema,
      variant: PluginDeclarativeActionVariantV2Schema.optional(),
      action: PluginDeclarativeProjectedQualifiedReferenceV1Schema.optional(),
      effect: PluginDeclarativeComposerApplyEffectV1Schema.optional(),
      hostAction: ActionIdSchema.optional(),
      input: PluginJsonValueV2Schema.optional(),
      enabled: z.boolean(),
    }).strict().superRefine((node, context) => {
      if ([node.action, node.hostAction, node.effect].filter((value) => value !== undefined).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['action'],
          message: 'A projected action must name exactly one contributed Action, host Action, or effect.',
        });
      }
      if (node.effect !== undefined && node.input !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['input'],
          message: 'A projected composerApply effect cannot carry Action input.',
        });
      }
    }),
    z.object({
      kind: z.literal('collectionList'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema.optional(),
      source: PluginDeclarativeCollectionListSourceV1Schema,
      query: NormalizedPluginCollectionUiQueryDescriptorV1Schema,
      projection: PluginDeclarativeCollectionListProjectionV1Schema,
      primaryCommand: PluginDeclarativeProjectedCollectionRowCommandV1Schema.optional(),
      secondaryCommands: z.array(PluginDeclarativeProjectedCollectionRowCommandV1Schema).optional(),
    }).strict(),
    z.object({
      kind: z.literal('list'),
      ...ProjectedNodeBaseV1Shape,
      label: PluginLocalizedStringV2Schema.optional(),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }).strict(),
    z.object({
      kind: z.literal('section'),
      ...ProjectedNodeBaseV1Shape,
      title: PluginLocalizedStringV2Schema.optional(),
      footer: PluginLocalizedStringV2Schema.optional(),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }).strict(),
    z.object({
      kind: z.literal('item'),
      ...ProjectedNodeBaseV1Shape,
      title: PluginLocalizedStringV2Schema,
      subtitle: PluginLocalizedStringV2Schema.optional(),
      detail: PluginLocalizedStringV2Schema.optional(),
      icon: PluginUiIconTokenV1Schema.optional(),
      tone: PluginDeclarativeToneV2Schema.optional(),
      action: PluginDeclarativeProjectedQualifiedReferenceV1Schema.optional(),
      input: PluginJsonValueV2Schema.optional(),
      enabled: z.boolean().optional(),
    }).strict().superRefine((node, context) => {
      if (node.action === undefined && (node.input !== undefined || node.enabled !== undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['action'],
          message: 'A projected item carries input/enabled only together with an Action.',
        });
      }
    }),
    PluginDeclarativeProjectedStateNodeV1Schema,
    z.object({
      kind: z.literal('targetedSurface'),
      ...ProjectedNodeBaseV1Shape,
      surface: PluginUiTargetedContributionSurfaceV1Schema,
      input: PluginJsonValueV2Schema,
      instanceKey: PluginUiInstanceKeyV1Schema,
      fallback: PluginDeclarativeProjectedStateNodeV1Schema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('metadata'),
      ...ProjectedNodeBaseV1Shape,
      title: PluginLocalizedStringV2Schema.optional(),
      entries: z.array(PluginDeclarativeMetadataEntryV2Schema)
        .min(1)
        .max(MAX_PLUGIN_DECLARATIVE_METADATA_ENTRIES_V2),
    }).strict(),
    z.object({
      kind: z.literal('actionPanel'),
      ...ProjectedNodeBaseV1Shape,
      title: PluginLocalizedStringV2Schema.optional(),
      children: z.array(PluginDeclarativeProjectedNodeV1Schema),
    }).strict(),
  ]),
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

export const PluginDeclarativeProjectedModelV1Schema: z.ZodType<PluginDeclarativeProjectedModelV1> =
  lazyZodSchema(() => z.object({
    identity: z.object({
      pluginId: asProtocolZod(PluginIdSchema),
      localId: asProtocolZod(PluginContributionLocalIdSchema),
      qualifiedId: z.string().trim().min(1).max(1_024),
      occurrenceId: z.string().trim().min(1).max(MAX_PLUGIN_DECLARATIVE_DOCUMENT_OCCURRENCE_LENGTH_V1).optional(),
    }).strict(),
    visible: z.boolean(),
    requiredHostMethods: z.array(PluginUiHostMethodV1Schema),
    declarativeInventory: z.object({
      actions: z.array(PluginDeclarativeProjectedActionBindingV1Schema),
      destinations: z.array(PluginDeclarativeProjectedQualifiedReferenceV1Schema),
      settings: z.array(PluginDeclarativeProjectedSettingsBindingV1Schema),
      uiQueries: z.array(NormalizedPluginCollectionUiQueryDescriptorV1Schema),
      dragSources: z.array(PluginDeclarativeProjectedQualifiedReferenceV1Schema.extend({ referenceSchema: PluginJsonSchemaV2Schema })).optional(),
      dropTargets: z.array(PluginDeclarativeProjectedQualifiedReferenceV1Schema).optional(),
    }).strict(),
    root: PluginDeclarativeProjectedNodeV1Schema,
  }).strict().superRefine((model, context) => {
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
      code: z.ZodIssueCode.custom,
      message: 'A declarative presentation without a runtime occurrence cannot enable effects or embed a current targeted Surface.',
    });
  }));
