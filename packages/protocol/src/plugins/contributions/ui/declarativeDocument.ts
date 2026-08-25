import { z } from 'zod';
import { asProtocolZod } from "../../actions/internalProtocolZodAdapter.js";

import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  PluginContributionLocalIdSchema,
  type PluginContributionIdentityV1,
} from '../../contributionIdentity.js';
import { PluginIdSchema } from '../../pluginId.js';
import {
  derivePluginUiTargetedSurfaceMountInstanceKeyV1,
  PluginUiTargetedContributionSurfaceV1Schema,
  type PluginUiTargetedContributionPointRefV1,
  type PluginUiTargetedContributionSurfaceV1,
} from '../../ui/targetedContributions.js';
import {
  NormalizedPluginCollectionUiQueryDescriptorV1Schema,
  validatePluginCollectionUiQueryParametersV1,
  type NormalizedPluginCollectionUiQueryDescriptorV1,
  type PluginCollectionProjectedScalarFieldRefV1,
  type PluginCollectionUiQueryRequestV1,
} from '../../data/collectionsV1.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  type PreparedPluginJsonSchema,
} from '../../actions/jsonSchemaValidation.js';
import { cloneStrictPluginJsonValue } from '../strictJsonValue.js';
import type {
  PluginContributionReferenceV2,
  PluginJsonSchemaV2,
  PluginJsonValueV2,
  PluginLocalizedStringV2,
} from '../publicTypes.js';
import { PluginJsonSchemaV2Schema, PluginJsonValueV2Schema } from '../publicTypes.js';
import { containsEquivalentPluginJsonValue } from '../jsonSchemaValues.js';
import {
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  PluginDeclarativeDocumentV1Schema,
  isPluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentV1,
} from './declarativeDocumentAuthoringV1.js';
import {
  preflightPluginDeclarativeDocumentV1,
} from './declarativeDocumentPreflightV1.js';
import {
  type PluginDeclarativeActionVariantV2,
  type PluginDeclarativeComposerApplyEffectV1,
  type PluginDeclarativeCollectionListProjectionV1,
  type PluginCollectionRowCommandV1,
  type PluginDeclarativeControlV2,
  type PluginDeclarativeMetadataEntryV2,
  type PluginDeclarativeNodeV2,
  type PluginDeclarativeStateV2,
  type PluginDeclarativeStateNodeV2,
  type PluginDeclarativeTargetedSurfaceNodeV2,
  type PluginDeclarativeToneV2,
  type PluginUiIconTokenV1,
} from './v2.js';

/**
 * The strict authoring envelope and its exact Resource media type are kept in
 * the browser-safe leaf. Normalization below remains the host-owned reader.
 */
export {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
  PluginDeclarativeDocumentContentTypeV1Schema,
  isPluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentContentTypeV1,
  type PluginDeclarativeDocumentV1,
  PluginDeclarativeDocumentV1Schema,
} from './declarativeDocumentAuthoringV1.js';
export { MAX_PLUGIN_DECLARATIVE_DOCUMENT_NODES_V1 } from './declarativeDocumentPreflightV1.js';
export { parsePluginDeclarativeDocumentResourceBytesV1 } from './declarativeDocumentPreflightV1.js';

const MAX_PLUGIN_DECLARATIVE_DOCUMENT_GENERATION_LENGTH_V1 = 256;

export type PluginDeclarativeDocumentNormalizationErrorCodeV1 =
  | 'plugin_declarative_identity_invalid'
  | 'plugin_declarative_generation_invalid'
  | 'plugin_declarative_invalid_plain_data'
  | 'plugin_declarative_document_invalid'
  | 'plugin_declarative_document_bytes_exceeded'
  | 'plugin_declarative_document_content_type_invalid'
  | 'plugin_declarative_action_inventory_invalid'
  | 'plugin_declarative_action_missing'
  | 'plugin_declarative_action_scope_invalid'
  | 'plugin_declarative_destination_inventory_invalid'
  | 'plugin_declarative_collection_command_missing'
  | 'plugin_declarative_collection_command_scope_invalid'
  | 'plugin_declarative_setting_inventory_invalid'
  | 'plugin_declarative_setting_missing'
  | 'plugin_declarative_setting_ambiguous'
  | 'plugin_declarative_setting_scope_invalid'
  | 'plugin_declarative_control_invalid'
  | 'plugin_declarative_options_bounded'
  | 'plugin_declarative_option_invalid'
  | 'plugin_declarative_option_duplicate'
  | 'plugin_declarative_item_action_missing'
  | 'plugin_declarative_collection_query_inventory_invalid'
  | 'plugin_declarative_collection_query_missing'
  | 'plugin_declarative_collection_query_scope_invalid'
  | 'plugin_declarative_collection_query_invalid'
  | 'plugin_declarative_collection_projection_invalid'
  | 'plugin_declarative_targeted_surface_inventory_invalid'
  | 'plugin_declarative_targeted_surface_inventory_missing'
  | 'plugin_declarative_targeted_surface_scope_invalid'
  | 'plugin_declarative_targeted_surface_missing'
  | 'plugin_declarative_targeted_surface_ambiguous'
  | 'plugin_declarative_targeted_surface_input_invalid'
  | 'plugin_declarative_targeted_surface_fill_root_required'
  | 'plugin_declarative_nodes_exceeded';

/** A typed, realm-neutral rejection for an entire declarative candidate. */
export class PluginDeclarativeDocumentNormalizationErrorV1 extends Error {
  readonly code: PluginDeclarativeDocumentNormalizationErrorCodeV1;

  constructor(code: PluginDeclarativeDocumentNormalizationErrorCodeV1, message: string) {
    super(message);
    this.name = 'PluginDeclarativeDocumentNormalizationErrorV1';
    this.code = code;
  }
}

export type PluginDeclarativeQualifiedReferenceV1 = Readonly<{
  identity: PluginContributionIdentityV1;
  qualifiedId: string;
  generation: string;
}>;

/**
 * Protocol-qualified row-command target. The host supplies the only row
 * invocation context later; this normalized form carries no fields or input.
 */
export type PluginDeclarativeCollectionRowCommandV1 =
  | Readonly<{
    kind: 'action';
    action: PluginDeclarativeQualifiedReferenceV1;
  }>
  | Readonly<{
    kind: 'openSurface';
    destination: PluginDeclarativeQualifiedReferenceV1;
  }>;

/**
 * A realm-neutral Settings binding admitted by the declarative model owner.
 * The binding is deliberately data-only: Protocol validates node compatibility
 * but never reads or writes a Settings record.
 */
export type PluginDeclarativeSettingsInventoryEntryV1 = Readonly<{
  pluginId: string;
  id: string;
  qualifiedId: string;
  schema: PluginJsonSchemaV2;
  secret: boolean;
}>;

export const PluginDeclarativeSettingsInventoryEntryV1Schema: z.ZodType<PluginDeclarativeSettingsInventoryEntryV1> = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  id: asProtocolZod(PluginContributionLocalIdSchema),
  qualifiedId: z.string().trim().min(1).max(1_024),
  schema: PluginJsonSchemaV2Schema,
  secret: z.boolean(),
}).strict();

export type PluginDeclarativeQualifiedSettingBindingV1 = Readonly<{
  pluginId: string;
  id: string;
  qualifiedId: string;
}>;

type PluginDeclarativeNormalizedNodeBaseV1 = Readonly<{
  path: string;
  order: number;
}>;

/**
 * The current admitted public identity of one embedded contributor. This is
 * emitted only after the host-private mounted inventory resolves an authored
 * symbolic reference; it never contains renderer, materialization, or input
 * schema facts.
 */
export type PluginDeclarativeTargetedSurfaceHandleV1 = PluginUiTargetedContributionSurfaceV1;

export type PluginDeclarativeNormalizedStateNodeV1 =
  PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'state';
    state: PluginDeclarativeStateV2;
    title: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
  }>;

export type PluginDeclarativeNormalizedTargetedSurfaceNodeV1 =
  PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'targetedSurface';
    surface: PluginDeclarativeTargetedSurfaceHandleV1;
    input: PluginJsonValueV2;
    /** Host-namespaced opaque mount identity, never the author raw key. */
    instanceKey: string;
    fallback?: PluginDeclarativeNormalizedStateNodeV1;
  }>;

export type PluginDeclarativeNormalizedNodeV1 =
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'text';
    text: PluginLocalizedStringV2;
    tone?: PluginDeclarativeToneV2;
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'markdown';
    text: PluginLocalizedStringV2;
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'stack';
    direction?: 'vertical' | 'horizontal';
    gap?: 'small' | 'medium' | 'large';
    children: readonly PluginDeclarativeNormalizedNodeV1[];
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'group';
    title?: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeNormalizedNodeV1[];
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'field';
    label: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    control: PluginDeclarativeControlV2;
    setting: PluginDeclarativeQualifiedSettingBindingV1;
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'status';
    label: PluginLocalizedStringV2;
    value: PluginLocalizedStringV2;
    tone?: PluginDeclarativeToneV2;
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'action';
    label: PluginLocalizedStringV2;
    variant?: PluginDeclarativeActionVariantV2;
    action: PluginDeclarativeQualifiedReferenceV1;
    input?: PluginJsonValueV2;
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'action';
    label: PluginLocalizedStringV2;
    variant?: PluginDeclarativeActionVariantV2;
    effect: PluginDeclarativeComposerApplyEffectV1;
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'collectionList';
    label?: PluginLocalizedStringV2;
    source: Readonly<{
      collectionId: string;
      uiQueryId: string;
      parameters: PluginCollectionUiQueryRequestV1['parameters'];
    }>;
    /** The exact descriptor from Data's immutable projected inventory. */
    query: NormalizedPluginCollectionUiQueryDescriptorV1;
    projection: PluginDeclarativeCollectionListProjectionV1;
    primaryCommand?: PluginDeclarativeCollectionRowCommandV1;
    secondaryCommands?: readonly PluginDeclarativeCollectionRowCommandV1[];
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'list';
    label?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeNormalizedNodeV1[];
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'section';
    title?: PluginLocalizedStringV2;
    footer?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeNormalizedNodeV1[];
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'item';
    title: PluginLocalizedStringV2;
    subtitle?: PluginLocalizedStringV2;
    detail?: PluginLocalizedStringV2;
    icon?: PluginUiIconTokenV1;
    tone?: PluginDeclarativeToneV2;
    action?: PluginDeclarativeQualifiedReferenceV1;
    input?: PluginJsonValueV2;
  }>)
  | PluginDeclarativeNormalizedStateNodeV1
  | PluginDeclarativeNormalizedTargetedSurfaceNodeV1
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'metadata';
    title?: PluginLocalizedStringV2;
    entries: readonly PluginDeclarativeMetadataEntryV2[];
  }>)
  | (PluginDeclarativeNormalizedNodeBaseV1 & Readonly<{
    kind: 'actionPanel';
    title?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeNormalizedNodeV1[];
  }>);

export type PluginDeclarativeDocumentNormalizationV1 = Readonly<{
  root: PluginDeclarativeNormalizedNodeV1;
  nodes: readonly PluginDeclarativeNormalizedNodeV1[];
}>;

export type NormalizePluginDeclarativeDocumentV1Input = Readonly<{
  pluginId: string;
  generation: string;
  document: unknown;
  /** The immutable admitted Action inventory for this candidate's plugin. */
  actions: readonly PluginContributionIdentityV1[];
  /**
   * Immutable catalog-admitted surface-destination identities for row commands.
   * A qualified cross-plugin destination can appear only after the manifest
   * catalog has admitted its exact destination family; the host resolver still
   * rechecks its installed/current navigation authority at invocation.
   */
  destinations?: readonly PluginContributionIdentityV1[];
  /**
   * The immutable admitted Settings bindings. `unknown` preserves this pure
   * boundary's responsibility to reject malformed cross-realm projections
   * rather than trusting a caller-local structural cast.
   */
  settings?: readonly unknown[];
  /**
   * Immutable normalized DATA-UI-QUERY descriptors projected by Data. The
   * normalizer validates this boundary and never parses Collection manifests.
   */
  uiQueries?: readonly unknown[];
  /**
   * Host-private prepared current target-local surface admission supplied only
   * by a generation owner. The executable validator is never wire data: the
   * owner prepares it once with the exact admitted schema and consumers reuse
   * that same pair for document normalization and physical mounting.
   * Static/global/session callers omit it, so an authored targeted Surface
   * cannot become a global selector or fabricate a handle.
   */
  preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
  /**
   * Required by a dynamic-Resource admission caller. The manifest owns the
   * declared side; the read result supplies the returned side. Static roots
   * intentionally omit this because they are not Resource bytes.
   */
  resourceContentTypes?: Readonly<{
    declaredContentType: unknown;
    returnedContentType: unknown;
  }>;
}>;

/** Static ceiling promoted from the former CLI-only evaluator. */
export const MAX_PLUGIN_DECLARATIVE_SELECT_OPTIONS_V1 = 128;

function fail(
  code: PluginDeclarativeDocumentNormalizationErrorCodeV1,
  message: string,
): never {
  throw new PluginDeclarativeDocumentNormalizationErrorV1(code, message);
}

/**
 * Reject a dynamic candidate unless both metadata authorities agree exactly.
 * MIME parameters and casing are semantically significant here: accepting a
 * looser JSON shape would make Resource declaration and returned bytes two
 * divergent type owners.
 */
export function assertPluginDeclarativeDocumentResourceContentTypesV1(
  declaredContentType: unknown,
  returnedContentType: unknown,
): PluginDeclarativeDocumentContentTypeV1 {
  if (
    !isPluginDeclarativeDocumentContentTypeV1(declaredContentType)
    || !isPluginDeclarativeDocumentContentTypeV1(returnedContentType)
  ) {
    return fail(
      'plugin_declarative_document_content_type_invalid',
      'Declarative document Resource content type must exactly match the V1 document media type',
    );
  }
  return PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1;
}

function cloneStrictPlainData(input: unknown): unknown {
  try {
    return cloneStrictPluginJsonValue(input, 'document');
  } catch (error) {
    return fail(
      'plugin_declarative_invalid_plain_data',
      error instanceof Error ? error.message : 'Document must contain strict JSON data',
    );
  }
}

function normalizePluginId(pluginId: string): string {
  const parsed = PluginIdSchema.safeParse(pluginId);
  if (!parsed.success) {
    return fail('plugin_declarative_identity_invalid', 'Plugin id is invalid');
  }
  return parsed.data;
}

function normalizeGeneration(generation: string): string {
  if (typeof generation !== 'string'
    || generation.trim().length === 0
    || generation.length > MAX_PLUGIN_DECLARATIVE_DOCUMENT_GENERATION_LENGTH_V1) {
    return fail('plugin_declarative_generation_invalid', 'Plugin generation is invalid');
  }
  return generation;
}

function buildContributionIdentityInventory(input: Readonly<{
  identities: readonly PluginContributionIdentityV1[];
  kind: 'action' | 'destination';
}>): ReadonlySet<string> {
  const inventoryError = input.kind === 'action'
    ? 'plugin_declarative_action_inventory_invalid' as const
    : 'plugin_declarative_destination_inventory_invalid' as const;
  const label = input.kind === 'action' ? 'Action' : 'Destination';
  let plain: unknown;
  try {
    plain = cloneStrictPlainData(input.identities);
  } catch (error) {
    if (error instanceof PluginDeclarativeDocumentNormalizationErrorV1) throw error;
    throw error;
  }
  if (!Array.isArray(plain)) {
    return fail(inventoryError, `${label} inventory is invalid`);
  }
  const identities = new Set<string>();
  for (const value of plain) {
    let identity: PluginContributionIdentityV1;
    try {
      identity = createPluginContributionIdentity(value as PluginContributionIdentityV1);
    } catch {
      return fail(inventoryError, `${label} inventory is invalid`);
    }
    const qualifiedId = buildQualifiedPluginContributionKey(identity);
    if (identities.has(qualifiedId)) {
      return fail(inventoryError, `${label} '${qualifiedId}' is duplicated`);
    }
    identities.add(qualifiedId);
  }
  return identities;
}

type SettingsInventory = ReadonlyMap<string, PluginDeclarativeSettingsInventoryEntryV1 | null>;

function buildSettingsInventory(
  pluginId: string,
  settings: readonly unknown[] | undefined,
): SettingsInventory {
  const plain = cloneStrictPlainData(settings ?? []);
  if (!Array.isArray(plain)) {
    return fail('plugin_declarative_setting_inventory_invalid', 'Settings inventory is invalid');
  }
  const bindings = new Map<string, PluginDeclarativeSettingsInventoryEntryV1 | null>();
  for (const value of plain) {
    const parsed = PluginDeclarativeSettingsInventoryEntryV1Schema.safeParse(value);
    if (!parsed.success) {
      return fail('plugin_declarative_setting_inventory_invalid', 'Settings inventory is invalid');
    }
    const binding = parsed.data;
    if (binding.pluginId !== pluginId) {
      return fail('plugin_declarative_setting_scope_invalid', `Setting '${binding.qualifiedId}' is outside the document plugin`);
    }
    if (bindings.has(binding.id)) {
      bindings.set(binding.id, null);
      continue;
    }
    bindings.set(binding.id, Object.freeze({
      pluginId: binding.pluginId,
      id: binding.id,
      qualifiedId: binding.qualifiedId,
      schema: binding.schema,
      secret: binding.secret,
    }));
  }
  return bindings;
}

function normalizeSettingReference(
  inventory: SettingsInventory,
  control: PluginDeclarativeControlV2,
): PluginDeclarativeQualifiedSettingBindingV1 {
  const binding = inventory.get(control.settingId);
  if (binding === null) {
    return fail('plugin_declarative_setting_ambiguous', `Setting '${control.settingId}' is ambiguous`);
  }
  if (!binding) {
    return fail('plugin_declarative_setting_missing', `Setting '${control.settingId}' is not declared`);
  }

  const schemaType = binding.schema.type;
  if (control.kind === 'secret') {
    if (binding.secret !== true || schemaType !== 'string') {
      return fail('plugin_declarative_control_invalid', `Secret control '${control.settingId}' is incompatible`);
    }
  } else {
    if (binding.secret === true
      || (control.kind === 'text' && schemaType !== 'string')
      || (control.kind === 'number' && schemaType !== 'number' && schemaType !== 'integer')
      || (control.kind === 'toggle' && schemaType !== 'boolean')) {
      return fail('plugin_declarative_control_invalid', `Control '${control.kind}' is incompatible with '${control.settingId}'`);
    }
    if (control.kind === 'select') {
      if (control.options.length > MAX_PLUGIN_DECLARATIVE_SELECT_OPTIONS_V1) {
        return fail('plugin_declarative_options_bounded', `Select '${control.settingId}' has too many options`);
      }
      let validate: ReturnType<typeof compilePluginJsonSchema>;
      try {
        validate = compilePluginJsonSchema(binding.schema);
      } catch {
        return fail('plugin_declarative_control_invalid', `Setting '${control.settingId}' has an invalid schema`);
      }
      const seen: PluginJsonValueV2[] = [];
      for (const option of control.options) {
        if (!isValidPluginJsonSchemaValue(validate, option.value)) {
          return fail('plugin_declarative_option_invalid', `Select '${control.settingId}' has an invalid option`);
        }
        if (containsEquivalentPluginJsonValue(seen, option.value)) {
          return fail('plugin_declarative_option_duplicate', `Select '${control.settingId}' has duplicate options`);
        }
        seen.push(option.value);
      }
    }
  }

  return Object.freeze({
    pluginId: binding.pluginId,
    id: binding.id,
    qualifiedId: binding.qualifiedId,
  });
}

/**
 * Host-private generation-local input retained beside an admitted embedded
 * Surface. It deliberately extends no wire or manifest schema: `validate` is
 * executable state and cannot cross a serialization boundary.
 */
export type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 = Readonly<{
  targetPluginId: string;
  handle: PluginDeclarativeTargetedSurfaceHandleV1;
  /** The exact canonical schema owned by `inputValidation`. */
  inputSchema: PluginJsonSchemaV2;
  /** One validator compiled by the admitted target/contributor generation owner. */
  inputValidation: PreparedPluginJsonSchema;
}>;

const PluginDeclarativeTargetedSurfaceHandleV1Schema: z.ZodType<
  PluginDeclarativeTargetedSurfaceHandleV1
> = PluginUiTargetedContributionSurfaceV1Schema;

type TargetedSurfaceInventory = ReadonlyMap<string, PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 | null>;

function targetedSurfaceSymbolicKey(input: Readonly<{
  point: PluginUiTargetedContributionPointRefV1;
  contributor: Readonly<{ pluginId: string; contributionId: string }>;
  role: string;
}>): string {
  return [
    input.point.pointId,
    input.point.protocol.id,
    String(input.point.protocol.version),
    input.contributor.pluginId,
    input.contributor.contributionId,
    input.role,
  ].join('\u0000');
}

function isPreparedTargetedSurfaceInventoryEntry(
  value: unknown,
): value is PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1>;
  if (typeof entry.targetPluginId !== 'string'
    || !PluginDeclarativeTargetedSurfaceHandleV1Schema.safeParse(entry.handle).success
    || !entry.inputSchema
    || typeof entry.inputSchema !== 'object'
    || Array.isArray(entry.inputSchema)
    || !entry.inputValidation
    || typeof entry.inputValidation !== 'object'
    || typeof entry.inputValidation.validate !== 'function') {
    return false;
  }
  // The generation owner retains one exact pair. A sibling schema plus an
  // arbitrary validator would recreate the split schema/validator ownership
  // this host-private seam replaces.
  return entry.inputValidation.jsonSchema === entry.inputSchema;
}

function buildPreparedTargetedSurfaceInventory(
  targetPluginId: string,
  targetedSurfaces: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[],
): TargetedSurfaceInventory {
  const inventory = new Map<string, PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 | null>();
  for (const entry of targetedSurfaces) {
    if (!isPreparedTargetedSurfaceInventoryEntry(entry)) {
      return fail('plugin_declarative_targeted_surface_inventory_invalid', 'Targeted Surface inventory is invalid');
    }
    if (entry.targetPluginId !== targetPluginId) {
      return fail(
        'plugin_declarative_targeted_surface_scope_invalid',
        `Targeted Surface '${targetedSurfaceSymbolicKey(entry.handle)}' is outside the mounted target`,
      );
    }
    const key = targetedSurfaceSymbolicKey(entry.handle);
    if (inventory.has(key)) {
      // A symbolic document reference cannot choose which generation wins.
      // Preserve the collision so a stale or forged duplicate never retargets.
      inventory.set(key, null);
      continue;
    }
    inventory.set(key, Object.freeze({
      targetPluginId: entry.targetPluginId,
      handle: Object.freeze({
        point: Object.freeze({
          pointId: entry.handle.point.pointId,
          protocol: Object.freeze({
            id: entry.handle.point.protocol.id,
            version: entry.handle.point.protocol.version,
          }),
        }),
        contributor: Object.freeze({ ...entry.handle.contributor }),
        role: entry.handle.role,
        presentation: entry.handle.presentation,
      }),
      inputSchema: entry.inputSchema,
      inputValidation: entry.inputValidation,
    }));
  }
  return inventory;
}

function normalizeTargetedSurfaceNode(input: Readonly<{
  targetPluginId: string;
  source: PluginDeclarativeTargetedSurfaceNodeV2;
  inventory: TargetedSurfaceInventory | undefined;
  isRoot: boolean;
  path: string;
  order: number;
  normalizeFallback(source: PluginDeclarativeStateNodeV2, path: string): PluginDeclarativeNormalizedStateNodeV1;
}>): PluginDeclarativeNormalizedTargetedSurfaceNodeV1 {
  if (!input.inventory) {
    return fail(
      'plugin_declarative_targeted_surface_inventory_missing',
      'Targeted Surface nodes require a mounted target inventory',
    );
  }
  const key = targetedSurfaceSymbolicKey(input.source.surface);
  const admitted = input.inventory.get(key);
  if (admitted === null) {
    return fail(
      'plugin_declarative_targeted_surface_ambiguous',
      `Targeted Surface '${key}' has more than one admitted generation`,
    );
  }
  if (!admitted) {
    return fail(
      'plugin_declarative_targeted_surface_missing',
      `Targeted Surface '${key}' is not admitted at the mounted target`,
    );
  }
  const parsedInput = PluginJsonValueV2Schema.safeParse(input.source.input);
  if (!parsedInput.success || !isValidPluginJsonSchemaValue(admitted.inputValidation.validate, parsedInput.data)) {
    return fail(
      'plugin_declarative_targeted_surface_input_invalid',
      `Targeted Surface '${key}' input does not satisfy its target role schema`,
    );
  }
  let normalizedInput: PluginJsonValueV2;
  try {
    normalizedInput = cloneStrictPluginJsonValue(
      parsedInput.data,
      'targeted Surface input',
    ) as PluginJsonValueV2;
  } catch {
    return fail(
      'plugin_declarative_targeted_surface_input_invalid',
      `Targeted Surface '${key}' input must contain strict JSON data`,
    );
  }
  if (admitted.handle.presentation === 'fill' && !input.isRoot) {
    return fail(
      'plugin_declarative_targeted_surface_fill_root_required',
      `Targeted Surface '${key}' with fill presentation must be the document root`,
    );
  }
  const fallback = input.source.fallback === undefined
    ? undefined
    : input.normalizeFallback(input.source.fallback, `${input.path}.fallback`);
  return Object.freeze({
    kind: 'targetedSurface',
    path: input.path,
    order: input.order,
    surface: admitted.handle,
    input: normalizedInput,
    instanceKey: derivePluginUiTargetedSurfaceMountInstanceKeyV1({
      targetPluginId: input.targetPluginId,
      surface: admitted.handle,
      rawInstanceKey: input.source.instanceKey,
    }),
    ...(fallback ? { fallback } : {}),
  });
}

function collectionUiQueryInventoryKey(collectionId: string, uiQueryId: string): string {
  return `${collectionId}\u0000${uiQueryId}`;
}

type CollectionUiQueryInventory = ReadonlyMap<string, NormalizedPluginCollectionUiQueryDescriptorV1>;

/**
 * Data is the sole producer of these descriptors. This boundary validates its
 * immutable projection but deliberately does not inspect Collection schemas,
 * indexes, storage, or runtime readiness.
 */
function buildCollectionUiQueryInventory(
  pluginId: string,
  uiQueries: readonly unknown[] | undefined,
): CollectionUiQueryInventory {
  const plain = cloneStrictPlainData(uiQueries ?? []);
  if (!Array.isArray(plain)) {
    return fail('plugin_declarative_collection_query_inventory_invalid', 'Collection UI-query inventory is invalid');
  }
  const inventory = new Map<string, NormalizedPluginCollectionUiQueryDescriptorV1>();
  for (const value of plain) {
    const parsed = NormalizedPluginCollectionUiQueryDescriptorV1Schema.safeParse(value);
    if (!parsed.success) {
      return fail('plugin_declarative_collection_query_inventory_invalid', 'Collection UI-query inventory is invalid');
    }
    const descriptor = parsed.data;
    if (descriptor.collection.pluginId !== pluginId) {
      return fail(
        'plugin_declarative_collection_query_scope_invalid',
        `Collection UI query '${descriptor.collection.collectionId}/${descriptor.id}' is outside the document plugin`,
      );
    }
    const key = collectionUiQueryInventoryKey(descriptor.collection.collectionId, descriptor.id);
    if (inventory.has(key)) {
      return fail('plugin_declarative_collection_query_inventory_invalid', `Collection UI query '${key}' is duplicated`);
    }
    inventory.set(key, descriptor);
  }
  return inventory;
}

function normalizeCollectionProjectionField(
  descriptor: NormalizedPluginCollectionUiQueryDescriptorV1,
  field: PluginCollectionProjectedScalarFieldRefV1,
): PluginCollectionProjectedScalarFieldRefV1 {
  const declared = descriptor.projectedFields.find((candidate) => candidate.field === field.field);
  if (!declared || declared.kind !== field.kind) {
    return fail(
      'plugin_declarative_collection_projection_invalid',
      `Collection projection field '${field.field}' is not declared by '${descriptor.id}'`,
    );
  }
  return Object.freeze({ field: declared.field, kind: declared.kind });
}

function normalizeCollectionListBinding(input: Readonly<{
  pluginId: string;
  generation: string;
  source: Extract<PluginDeclarativeNodeV2, { kind: 'collectionList' }>;
  inventory: CollectionUiQueryInventory;
  actions: ReadonlySet<string>;
  destinations: ReadonlySet<string>;
}>): Readonly<{
  source: Readonly<{
    collectionId: string;
    uiQueryId: string;
    parameters: PluginCollectionUiQueryRequestV1['parameters'];
  }>;
  query: NormalizedPluginCollectionUiQueryDescriptorV1;
  projection: PluginDeclarativeCollectionListProjectionV1;
  primaryCommand?: PluginDeclarativeCollectionRowCommandV1;
  secondaryCommands?: readonly PluginDeclarativeCollectionRowCommandV1[];
}> {
  const query = input.inventory.get(
    collectionUiQueryInventoryKey(input.source.source.collectionId, input.source.source.uiQueryId),
  );
  if (!query) {
    return fail(
      'plugin_declarative_collection_query_missing',
      `Collection UI query '${input.source.source.collectionId}/${input.source.source.uiQueryId}' is not declared`,
    );
  }
  const parameters = Object.freeze({ ...(input.source.source.parameters ?? {}) });
  try {
    validatePluginCollectionUiQueryParametersV1(query, parameters);
  } catch {
    return fail(
      'plugin_declarative_collection_query_invalid',
      `Collection UI query '${query.id}' parameters are invalid`,
    );
  }
  const projection = input.source.projection;
  const primaryCommand = input.source.primaryCommand === undefined
    ? undefined
    : normalizeCollectionRowCommand({
      pluginId: input.pluginId,
      generation: input.generation,
      actions: input.actions,
      destinations: input.destinations,
      command: input.source.primaryCommand,
    });
  const secondaryCommands = input.source.secondaryCommands === undefined
    ? undefined
    : Object.freeze(input.source.secondaryCommands.map((command) => normalizeCollectionRowCommand({
      pluginId: input.pluginId,
      generation: input.generation,
      actions: input.actions,
      destinations: input.destinations,
      command,
    })));
  return Object.freeze({
    source: Object.freeze({
      collectionId: query.collection.collectionId,
      uiQueryId: query.id,
      parameters,
    }),
    query,
    projection: Object.freeze({
      titleField: normalizeCollectionProjectionField(query, projection.titleField),
      ...(projection.subtitleField
        ? { subtitleField: normalizeCollectionProjectionField(query, projection.subtitleField) }
        : {}),
      ...(projection.detailField
        ? { detailField: normalizeCollectionProjectionField(query, projection.detailField) }
        : {}),
      ...(projection.badgeField
        ? { badgeField: normalizeCollectionProjectionField(query, projection.badgeField) }
        : {}),
      ...(projection.statusField
        ? { statusField: normalizeCollectionProjectionField(query, projection.statusField) }
        : {}),
    }),
    ...(primaryCommand ? { primaryCommand } : {}),
    ...(secondaryCommands ? { secondaryCommands } : {}),
  });
}

function normalizeContributionReference(input: Readonly<{
  pluginId: string;
  generation: string;
  inventory: ReadonlySet<string>;
  reference: PluginContributionReferenceV2;
  label: string;
  missingCode: 'plugin_declarative_action_missing' | 'plugin_declarative_collection_command_missing';
  scopeCode: 'plugin_declarative_action_scope_invalid' | 'plugin_declarative_collection_command_scope_invalid';
  allowQualifiedCrossPlugin?: boolean;
}>): PluginDeclarativeQualifiedReferenceV1 {
  const {
    pluginId,
    generation,
    inventory,
    reference,
    label,
    missingCode,
    scopeCode,
  } = input;
  let identity: PluginContributionIdentityV1;
  try {
    identity = createPluginContributionIdentity(typeof reference === 'string'
      ? { pluginId, localId: reference }
      : reference);
  } catch {
    return fail(missingCode, `${label} reference is invalid`);
  }
  if (identity.pluginId !== pluginId && input.allowQualifiedCrossPlugin !== true) {
    return fail(scopeCode, `${label} '${buildQualifiedPluginContributionKey(identity)}' is outside the document plugin`);
  }
  const qualifiedId = buildQualifiedPluginContributionKey(identity);
  if (!inventory.has(qualifiedId)) {
    return fail(missingCode, `${label} '${qualifiedId}' is not declared`);
  }
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    qualifiedId,
    generation,
  });
}

function normalizeActionReference(
  pluginId: string,
  generation: string,
  inventory: ReadonlySet<string>,
  reference: PluginContributionReferenceV2,
): PluginDeclarativeQualifiedReferenceV1 {
  return normalizeContributionReference({
    pluginId,
    generation,
    inventory,
    reference,
    label: 'Action',
    missingCode: 'plugin_declarative_action_missing',
    scopeCode: 'plugin_declarative_action_scope_invalid',
  });
}

function normalizeCollectionRowCommand(input: Readonly<{
  pluginId: string;
  generation: string;
  actions: ReadonlySet<string>;
  destinations: ReadonlySet<string>;
  command: PluginCollectionRowCommandV1;
}>): PluginDeclarativeCollectionRowCommandV1 {
  if (input.command.kind === 'action') {
    return Object.freeze({
      kind: 'action',
      action: normalizeContributionReference({
        pluginId: input.pluginId,
        generation: input.generation,
        inventory: input.actions,
        reference: input.command.action,
        label: 'Collection row command Action',
        missingCode: 'plugin_declarative_collection_command_missing',
        scopeCode: 'plugin_declarative_collection_command_scope_invalid',
      }),
    });
  }
  return Object.freeze({
    kind: 'openSurface',
    destination: normalizeContributionReference({
      pluginId: input.pluginId,
      generation: input.generation,
      inventory: input.destinations,
      reference: input.command.destination,
      label: 'Collection row command destination',
      missingCode: 'plugin_declarative_collection_command_missing',
      scopeCode: 'plugin_declarative_collection_command_scope_invalid',
      allowQualifiedCrossPlugin: true,
    }),
  });
}

/**
 * Parse and normalize a whole declarative document before any renderer adopts
 * it. The function has no runtime, Settings, Data, persistence, or UI state:
 * callers supply only an immutable admitted Action inventory and publish its
 * result atomically under their own lifecycle/currentness owner.
 */
export function normalizePluginDeclarativeDocumentV1(
  input: NormalizePluginDeclarativeDocumentV1Input,
): PluginDeclarativeDocumentNormalizationV1 {
  const pluginId = normalizePluginId(input.pluginId);
  const generation = normalizeGeneration(input.generation);
  if (input.resourceContentTypes) {
    assertPluginDeclarativeDocumentResourceContentTypesV1(
      input.resourceContentTypes.declaredContentType,
      input.resourceContentTypes.returnedContentType,
    );
  }
  const preflight = preflightPluginDeclarativeDocumentV1(input.document);
  if (!preflight.ok) {
    return fail(preflight.code, preflight.message);
  }
  const plainDocument = preflight.document;
  const parsedDocument = PluginDeclarativeDocumentV1Schema.safeParse(plainDocument);
  if (!parsedDocument.success) {
    return fail('plugin_declarative_document_invalid', 'Declarative document is invalid');
  }
  const actions = buildContributionIdentityInventory({
    identities: input.actions,
    kind: 'action',
  });
  const destinations = buildContributionIdentityInventory({
    identities: input.destinations ?? [],
    kind: 'destination',
  });
  const settings = buildSettingsInventory(pluginId, input.settings);
  const uiQueries = buildCollectionUiQueryInventory(pluginId, input.uiQueries);
  const targetedSurfaces = input.preparedTargetedSurfaces === undefined
    ? undefined
    : buildPreparedTargetedSurfaceInventory(pluginId, input.preparedTargetedSurfaces);
  const nodes: PluginDeclarativeNormalizedNodeV1[] = [];

  function normalizeNode(
    source: PluginDeclarativeNodeV2,
    path: string,
    isRoot: boolean,
  ): PluginDeclarativeNormalizedNodeV1 {
    const order = nodes.length;
    nodes.push(undefined as unknown as PluginDeclarativeNormalizedNodeV1);
    const normalizeChildren = (children: readonly PluginDeclarativeNodeV2[]) => Object.freeze(
      children.map((child, index) => normalizeNode(child, `${path}.children[${index}]`, false)),
    );
    let normalized: PluginDeclarativeNormalizedNodeV1;
    switch (source.kind) {
      case 'stack':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.direction ? { direction: source.direction } : {}),
          ...(source.gap ? { gap: source.gap } : {}),
          children: normalizeChildren(source.children),
        });
        break;
      case 'group':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.title ? { title: source.title } : {}),
          ...(source.description ? { description: source.description } : {}),
          children: normalizeChildren(source.children),
        });
        break;
      case 'list':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.label ? { label: source.label } : {}),
          children: normalizeChildren(source.children),
        });
        break;
      case 'section':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.title ? { title: source.title } : {}),
          ...(source.footer ? { footer: source.footer } : {}),
          children: normalizeChildren(source.children),
        });
        break;
      case 'actionPanel':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.title ? { title: source.title } : {}),
          children: normalizeChildren(source.children),
        });
        break;
      case 'field':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          label: source.label,
          ...(source.description ? { description: source.description } : {}),
          control: source.control,
          setting: normalizeSettingReference(settings, source.control),
        });
        break;
      case 'action':
        if (source.effect !== undefined) {
          normalized = Object.freeze({
            kind: 'action',
            path,
            order,
            label: source.label,
            ...(source.variant ? { variant: source.variant } : {}),
            effect: Object.freeze({
              kind: source.effect.kind,
              expectedRevision: source.effect.expectedRevision,
              operations: Object.freeze([...source.effect.operations]),
            }),
          });
        } else {
          if (source.action === undefined) {
            return fail('plugin_declarative_document_invalid', 'Declarative Action is missing its Action reference');
          }
          normalized = Object.freeze({
            kind: 'action',
            path,
            order,
            action: normalizeActionReference(pluginId, generation, actions, source.action),
            label: source.label,
            ...(source.variant ? { variant: source.variant } : {}),
            ...(source.input === undefined ? {} : { input: source.input }),
          });
        }
        break;
      case 'collectionList': {
        const binding = normalizeCollectionListBinding({
          pluginId,
          generation,
          source,
          inventory: uiQueries,
          actions,
          destinations,
        });
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.label ? { label: source.label } : {}),
          source: binding.source,
          query: binding.query,
          projection: binding.projection,
          ...(binding.primaryCommand ? { primaryCommand: binding.primaryCommand } : {}),
          ...(binding.secondaryCommands ? { secondaryCommands: binding.secondaryCommands } : {}),
        });
        break;
      }
      case 'item': {
        if (source.action === undefined && source.input !== undefined) {
          return fail('plugin_declarative_item_action_missing', `Item '${path}' declares an input without an action`);
        }
        const action = source.action === undefined
          ? undefined
          : normalizeActionReference(pluginId, generation, actions, source.action);
        normalized = Object.freeze({
          kind: 'item',
          path,
          order,
          title: source.title,
          ...(source.subtitle ? { subtitle: source.subtitle } : {}),
          ...(source.detail ? { detail: source.detail } : {}),
          ...(source.icon ? { icon: source.icon } : {}),
          ...(source.tone ? { tone: source.tone } : {}),
          ...(action ? { action } : {}),
          ...(source.input === undefined ? {} : { input: source.input }),
        });
        break;
      }
      case 'state':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          state: source.state,
          title: source.title,
          ...(source.description ? { description: source.description } : {}),
          ...(source.icon ? { icon: source.icon } : {}),
        });
        break;
      case 'targetedSurface':
        normalized = normalizeTargetedSurfaceNode({
          targetPluginId: pluginId,
          source,
          inventory: targetedSurfaces,
          isRoot,
          path,
          order,
          normalizeFallback(fallback, fallbackPath) {
            const normalizedFallback = normalizeNode(fallback, fallbackPath, false);
            if (normalizedFallback.kind !== 'state') {
              return fail(
                'plugin_declarative_document_invalid',
                `Targeted Surface fallback '${fallbackPath}' is not a state node`,
              );
            }
            return normalizedFallback;
          },
        });
        break;
      case 'metadata':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          ...(source.title ? { title: source.title } : {}),
          entries: Object.freeze(source.entries.map((entry) => Object.freeze({
            label: entry.label,
            value: entry.value,
            ...(entry.tone ? { tone: entry.tone } : {}),
          }))),
        });
        break;
      case 'text':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          text: source.text,
          ...(source.tone ? { tone: source.tone } : {}),
        });
        break;
      case 'markdown':
        normalized = Object.freeze({ kind: source.kind, path, order, text: source.text });
        break;
      case 'status':
        normalized = Object.freeze({
          kind: source.kind,
          path,
          order,
          label: source.label,
          value: source.value,
          ...(source.tone ? { tone: source.tone } : {}),
        });
        break;
      default: {
        const unreachable: never = source;
        return fail('plugin_declarative_document_invalid', `Unsupported declarative node '${JSON.stringify(unreachable)}'`);
      }
    }
    nodes[order] = normalized;
    return normalized;
  }

  const root = normalizeNode(parsedDocument.data.root, 'root', true);
  return Object.freeze({
    root,
    nodes: Object.freeze(nodes),
  });
}
