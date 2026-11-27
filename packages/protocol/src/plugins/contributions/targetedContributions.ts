import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  PluginActionDangerLevelV2Schema,
  PluginActionSurfaceV2Schema,
} from '../actions/vocabulary.js';
import {
  admitCanonicalProtocolComposableSchema,
  rehydrateCanonicalProtocolComposableSchema,
  cloneStrictPluginJsonValue,
  type ProtocolComposableSchema,
  type ProtocolJsonValue,
} from '../actions/protocolComposableSchema.js';
import {
  PluginContributionLocalIdSchema,
  PluginContributionOperationRoleV1Schema,
  PluginContributionProtocolIdV1Schema,
} from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginUiRendererChainBindingV1Schema,
} from './ui/rendererChainBinding.js';
import {
  PLUGIN_UI_TARGETED_CONTRIBUTION_OPERATIONS_MAX_V1,
  PLUGIN_UI_TARGETED_CONTRIBUTION_POINTS_MAX_V1,
  PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1,
  PLUGIN_UI_TARGETED_CONTRIBUTION_SURFACES_MAX_V1,
  PluginUiTargetedContributionSurfacePresentationV1Schema,
  type PluginUiTargetedContributionSurfacePresentationV1,
} from '../ui/targetedContributions.js';
import { PluginJsonSchemaV2Schema, PluginJsonValueV2Schema, type PluginJsonSchemaV2 } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

function boundedOperationMap<TValue extends z.core.SomeType>(valueSchema: TValue): z.ZodMiniType<Record<string, z.infer<TValue>>> {
  return z.record(PluginContributionOperationRoleV1Schema, valueSchema).check(z.superRefine((operations, ctx) => {
    const count = Object.keys(operations).length;
    if (count > PLUGIN_UI_TARGETED_CONTRIBUTION_OPERATIONS_MAX_V1) {
      ctx.addIssue({
        code: "custom",
        message: `Targeted contribution operation maps may contain at most ${PLUGIN_UI_TARGETED_CONTRIBUTION_OPERATIONS_MAX_V1} roles.`,
      });
    }
  }));
}

function boundedSurfaceMap<TValue extends z.ZodMiniType>(valueSchema: TValue): z.ZodMiniType<Record<string, z.infer<TValue>>> {
  return z.record(asProtocolZod(PluginContributionLocalIdSchema), valueSchema).check(z.superRefine((surfaces, ctx) => {
    const count = Object.keys(surfaces).length;
    if (count < 1 || count > PLUGIN_UI_TARGETED_CONTRIBUTION_SURFACES_MAX_V1) {
      ctx.addIssue({
        code: "custom",
        message: `Targeted contribution surface maps must contain 1 to ${PLUGIN_UI_TARGETED_CONTRIBUTION_SURFACES_MAX_V1} roles.`,
      });
    }
  }));
}

const TargetedContributionProtocolVersionSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.int()));

export const PluginTargetedContributionProtocolV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionProtocolIdV1Schema),
  version: TargetedContributionProtocolVersionSchema,
}));
export type PluginTargetedContributionProtocolV1 = z.infer<typeof PluginTargetedContributionProtocolV1Schema>;

export const PluginTargetedContributionOperationInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('contributorDefined') }),
  z.strictObject({ kind: z.literal('protocolDefined'), schema: PluginJsonSchemaV2Schema }),
]));
export type PluginTargetedContributionOperationInputV1 = z.infer<typeof PluginTargetedContributionOperationInputV1Schema>;

export const PluginTargetedContributionOperationRequirementsV1Schema = lazyZodSchema(() => z.strictObject({
  surfaces: z.array(PluginActionSurfaceV2Schema).check(z.minLength(1)),
  dangerLevel: PluginActionDangerLevelV2Schema,
}));
export type PluginTargetedContributionOperationRequirementsV1 = z.infer<typeof PluginTargetedContributionOperationRequirementsV1Schema>;

export const PluginTargetedContributionOperationV1Schema = lazyZodSchema(() => z.strictObject({
  required: z.boolean(),
  input: PluginTargetedContributionOperationInputV1Schema,
  resultSchema: PluginJsonSchemaV2Schema,
  action: PluginTargetedContributionOperationRequirementsV1Schema,
}));
export type PluginTargetedContributionOperationV1 = z.infer<typeof PluginTargetedContributionOperationV1Schema>;

/** The manifest and mounted-UI projection share this one Surface presentation vocabulary. */
export const PluginTargetedContributionSurfacePresentationV1Schema =
  lazyZodSchema(() => PluginUiTargetedContributionSurfacePresentationV1Schema);
export type PluginTargetedContributionSurfacePresentationV1 =
  PluginUiTargetedContributionSurfacePresentationV1;

/** Target-owned embedded surface contract; renderer selection remains with `ui.renderers`. */
export const PluginTargetedContributionSurfaceV1Schema = lazyZodSchema(() => z.strictObject({
  required: z.boolean(),
  inputSchema: PluginJsonSchemaV2Schema,
  presentation: PluginTargetedContributionSurfacePresentationV1Schema,
}));
export type PluginTargetedContributionSurfaceV1 = z.infer<typeof PluginTargetedContributionSurfaceV1Schema>;

export const PluginContributionPointProtocolV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionProtocolIdV1Schema),
  version: TargetedContributionProtocolVersionSchema,
  descriptor: z.optional(PluginJsonSchemaV2Schema),
  operations: boundedOperationMap(PluginTargetedContributionOperationV1Schema),
  surfaces: z.optional(boundedSurfaceMap(PluginTargetedContributionSurfaceV1Schema)),
}).check(z.superRefine((protocol, ctx) => {
  if (
    protocol.descriptor === undefined
    && Object.keys(protocol.operations).length === 0
    && Object.keys(protocol.surfaces ?? {}).length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'A contribution protocol must declare a descriptor, operation, or Surface role.',
    });
  }
})));
export type PluginContributionPointProtocolV1 = z.infer<typeof PluginContributionPointProtocolV1Schema>;

/**
 * The executable facts Protocol can reconstruct from one exact canonical
 * contribution-point manifest protocol. This deliberately excludes generic
 * JSON Schema compilation: schemas that were not emitted by Protocol's
 * composable-schema DSL return `null` from the rehydrator below.
 */
export type RehydratedPluginContributionPointOperationV1 = Readonly<{
  role: string;
  input: Readonly<{ kind: 'contributorDefined' }>
    | Readonly<{
      kind: 'protocolDefined';
      schema: ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>;
    }>;
  resultSchema: ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>;
}>;

export type RehydratedPluginContributionPointSurfaceV1 = Readonly<{
  role: string;
  /** Exact target-owned launch-input parser rehydrated from canonical manifest bytes. */
  inputSchema: ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>;
  presentation: PluginTargetedContributionSurfacePresentationV1;
}>;

export type RehydratedPluginContributionPointSemanticsV1 = Readonly<{
  descriptor?: ProtocolComposableSchema<ProtocolJsonValue, ProtocolJsonValue>;
  operations: readonly RehydratedPluginContributionPointOperationV1[];
  surfaces: readonly RehydratedPluginContributionPointSurfaceV1[];
}>;

/**
 * Reconstructs target-owned semantic parsers from the parsed cold manifest.
 * Both CLI admission and SDK test fixtures call this owner, so neither needs
 * an executable point sidecar or a second JSON Schema decoder.
 */
export function rehydratePluginContributionPointSemanticsV1(
  protocol: PluginContributionPointProtocolV1,
): RehydratedPluginContributionPointSemanticsV1 | null {
  // Validity is decided here, as admission needs it; each parser is built on its first read
  // (most daemons never invoke most contribution points) and then kept by its owner.
  const admitted = (schema: PluginJsonSchemaV2) => admitCanonicalProtocolComposableSchema(schema);
  // The rehydrator owns the parser once built; the admitted document is immutable, so it
  // always rehydrates to the same parser.
  const parserOf = (document: PluginJsonSchemaV2) => () => {
    const parser = rehydrateCanonicalProtocolComposableSchema(document);
    if (!parser) throw new Error('An admitted canonical contribution schema no longer rehydrates');
    return parser;
  };
  const withParser = <T extends object>(target: T, key: string, document: PluginJsonSchemaV2): T => {
    Object.defineProperty(target, key, { get: parserOf(document), enumerable: true, configurable: false });
    return target;
  };

  const descriptorDocument = protocol.descriptor === undefined ? undefined : admitted(protocol.descriptor);
  if (descriptorDocument === null) return null;

  const operations: RehydratedPluginContributionPointOperationV1[] = [];
  for (const role of Object.keys(protocol.operations).sort()) {
    const operation = protocol.operations[role]!;
    const inputDocument = operation.input.kind === 'contributorDefined' ? undefined : admitted(operation.input.schema);
    const resultDocument = admitted(operation.resultSchema);
    if (inputDocument === null || resultDocument === null) return null;
    const input = inputDocument === undefined
      ? Object.freeze({ kind: 'contributorDefined' as const })
      : Object.freeze(withParser({ kind: 'protocolDefined' as const }, 'schema', inputDocument));
    operations.push(Object.freeze(withParser({ role, input }, 'resultSchema', resultDocument)) as RehydratedPluginContributionPointOperationV1);
  }

  const surfaces: RehydratedPluginContributionPointSurfaceV1[] = [];
  for (const role of Object.keys(protocol.surfaces ?? {}).sort()) {
    const surface = protocol.surfaces?.[role];
    if (!surface) return null;
    const inputDocument = admitted(surface.inputSchema);
    if (inputDocument === null) return null;
    surfaces.push(Object.freeze(withParser({ role, presentation: surface.presentation }, 'inputSchema', inputDocument)) as RehydratedPluginContributionPointSurfaceV1);
  }

  const semantics = descriptorDocument === undefined ? {} : withParser({}, 'descriptor', descriptorDocument);
  return Object.freeze(Object.assign(semantics, {
    operations: Object.freeze(operations),
    surfaces: Object.freeze(surfaces),
  })) as RehydratedPluginContributionPointSemanticsV1;
}

export const PluginContributionPointV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  maxContributionsPerContributor: z.optional(z.number().check(z.int(), z.positive())),
  protocols: z.array(PluginContributionPointProtocolV1Schema).check(z.minLength(1), z.maxLength(PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1)),
}).check(z.superRefine((point, ctx) => {
  const seen = new Set<string>();
  point.protocols.forEach((protocol, index) => {
    const key = `${protocol.id}/${protocol.version}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ['protocols', index],
        message: 'Duplicate targeted contribution protocol identity.',
      });
    }
    seen.add(key);
  });
})));
export type PluginContributionPointV1 = z.infer<typeof PluginContributionPointV1Schema>;

/** Prepare exact schema bytes at declaration acquisition, never an admission decision. */
export function preparePluginContributionPointDeclarationsV1<T extends Readonly<{
  pluginContributionPoints: readonly PluginContributionPointV1[];
}>>(contributes: T): T {
  if (contributes.pluginContributionPoints.length === 0) return contributes;
  const prepareSchema = (schema: PluginJsonSchemaV2): PluginJsonSchemaV2 => {
    // The strict clone preserves this already schema-parsed JSON shape and owns
    // its immutable identity; the existing decoder still validates new input.
    let owned: PluginJsonSchemaV2;
    try {
      owned = cloneStrictPluginJsonValue(schema, 'schema') as PluginJsonSchemaV2;
    } catch {
      // The decoder owns point-local refusal. Preparation must not reject an
      // otherwise admitted release or its unrelated contribution points.
      return schema;
    }
    // Owning declaration bytes is not demand for an executable parser. The
    // canonical rehydrator admits/compiles this immutable schema on first use.
    return owned;
  };
  return { ...contributes, pluginContributionPoints: contributes.pluginContributionPoints.map(point => ({
    ...point,
    protocols: point.protocols.map(protocol => ({
      ...protocol,
      ...(protocol.descriptor === undefined ? {} : { descriptor: prepareSchema(protocol.descriptor) }),
      operations: Object.fromEntries(Object.entries(protocol.operations).map(([role, operation]) => [role, {
        ...operation,
        input: operation.input.kind === 'protocolDefined'
          ? { ...operation.input, schema: prepareSchema(operation.input.schema) } : operation.input,
        resultSchema: prepareSchema(operation.resultSchema),
      }])),
      ...(protocol.surfaces === undefined ? {} : { surfaces: Object.fromEntries(Object.entries(protocol.surfaces)
        .map(([role, surface]) => [role, { ...surface, inputSchema: prepareSchema(surface.inputSchema) }])) }),
    })),
  })) };
}

export const PluginTargetedContributionTargetV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  pointId: asProtocolZod(PluginContributionLocalIdSchema),
}));
export type PluginTargetedContributionTargetV1 = z.infer<typeof PluginTargetedContributionTargetV1Schema>;

export const PluginTargetedContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  target: PluginTargetedContributionTargetV1Schema,
  protocol: PluginTargetedContributionProtocolV1Schema,
  descriptor: z.optional(PluginJsonValueV2Schema),
  operations: boundedOperationMap(asProtocolZod(PluginContributionLocalIdSchema)),
  surfaces: z.optional(boundedSurfaceMap(PluginUiRendererChainBindingV1Schema)),
}).check(z.superRefine((contribution, ctx) => {
  if (
    contribution.descriptor === undefined
    && Object.keys(contribution.operations).length === 0
    && Object.keys(contribution.surfaces ?? {}).length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      message: 'A targeted contribution must bind a descriptor, operation, or Surface role.',
    });
  }
})));
export type PluginTargetedContributionV1 = z.infer<typeof PluginTargetedContributionV1Schema>;

/**
 * A target's declared points must fit its mounted UI snapshot. Catalog
 * admission owns target presence, role qualification and active contributions.
 */
export function validateTargetedContributionEnvelopeBoundsV1(
  value: Readonly<{
    pluginContributionPoints: readonly PluginContributionPointV1[];
    targetedPluginContributions: readonly PluginTargetedContributionV1[];
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.pluginContributionPoints.length > PLUGIN_UI_TARGETED_CONTRIBUTION_POINTS_MAX_V1) {
    ctx.addIssue({
      code: "custom",
      path: ['pluginContributionPoints'],
      message: `At most ${PLUGIN_UI_TARGETED_CONTRIBUTION_POINTS_MAX_V1} targeted contribution points are allowed.`,
    });
  }
}
