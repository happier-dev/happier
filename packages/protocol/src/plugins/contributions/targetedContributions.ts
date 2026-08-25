import { z } from 'zod';

import {
  PluginActionDangerLevelV2Schema,
  PluginActionSurfaceV2Schema,
  PluginJsonSchemaV2Schema,
} from '../actions/v2.js';
import {
  rehydrateCanonicalProtocolComposableSchema,
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
  PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1,
  PluginUiTargetedContributionSurfacePresentationV1Schema,
  type PluginUiTargetedContributionSurfacePresentationV1,
} from '../ui/targetedContributions.js';
import { PluginJsonValueV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const TARGETED_CONTRIBUTION_MAX_ROLES_PER_PROTOCOL = 16;
const TARGETED_CONTRIBUTION_MAX_POINTS_PER_PLUGIN = 16;
const TARGETED_CONTRIBUTION_MAX_TARGET_PLUGINS_PER_CONTRIBUTOR = 16;
const TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_PLUGIN = 64;
const TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_POINT = 16;
const TARGETED_CONTRIBUTION_MAX_POINT_SCHEMA_BYTES = 64 * 1024;
const TARGETED_CONTRIBUTION_MAX_DESCRIPTOR_BYTES = 16 * 1024;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedOperationMap<TValue extends z.core.SomeType>(valueSchema: TValue): z.ZodType<Record<string, z.infer<TValue>>> {
  return z.record(PluginContributionOperationRoleV1Schema, valueSchema).superRefine((operations, ctx) => {
    const count = Object.keys(operations).length;
    if (count > TARGETED_CONTRIBUTION_MAX_ROLES_PER_PROTOCOL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Targeted contribution operation maps may contain at most ${TARGETED_CONTRIBUTION_MAX_ROLES_PER_PROTOCOL} roles.`,
      });
    }
  });
}

function boundedSurfaceMap<TValue extends z.ZodTypeAny>(valueSchema: TValue): z.ZodType<Record<string, z.infer<TValue>>> {
  return z.record(asProtocolZod(PluginContributionLocalIdSchema), valueSchema).superRefine((surfaces, ctx) => {
    const count = Object.keys(surfaces).length;
    if (count < 1 || count > TARGETED_CONTRIBUTION_MAX_ROLES_PER_PROTOCOL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Targeted contribution surface maps must contain 1 to ${TARGETED_CONTRIBUTION_MAX_ROLES_PER_PROTOCOL} roles.`,
      });
    }
  });
}

const TargetedContributionProtocolVersionSchema = z.number().int().positive().safe();

export const PluginTargetedContributionProtocolV1Schema = z.object({
  id: asProtocolZod(PluginContributionProtocolIdV1Schema),
  version: TargetedContributionProtocolVersionSchema,
}).strict();
export type PluginTargetedContributionProtocolV1 = z.infer<typeof PluginTargetedContributionProtocolV1Schema>;

export const PluginTargetedContributionOperationInputV1Schema = z.union([
  z.object({ kind: z.literal('contributorDefined') }).strict(),
  z.object({ kind: z.literal('protocolDefined'), schema: PluginJsonSchemaV2Schema }).strict(),
]);
export type PluginTargetedContributionOperationInputV1 = z.infer<typeof PluginTargetedContributionOperationInputV1Schema>;

export const PluginTargetedContributionOperationRequirementsV1Schema = z.object({
  surface: PluginActionSurfaceV2Schema,
  dangerLevel: PluginActionDangerLevelV2Schema,
}).strict();
export type PluginTargetedContributionOperationRequirementsV1 = z.infer<typeof PluginTargetedContributionOperationRequirementsV1Schema>;

export const PluginTargetedContributionOperationV1Schema = z.object({
  required: z.boolean(),
  input: PluginTargetedContributionOperationInputV1Schema,
  resultSchema: PluginJsonSchemaV2Schema,
  action: PluginTargetedContributionOperationRequirementsV1Schema,
}).strict();
export type PluginTargetedContributionOperationV1 = z.infer<typeof PluginTargetedContributionOperationV1Schema>;

/** The manifest and mounted-UI projection share this one Surface presentation vocabulary. */
export const PluginTargetedContributionSurfacePresentationV1Schema =
  PluginUiTargetedContributionSurfacePresentationV1Schema;
export type PluginTargetedContributionSurfacePresentationV1 =
  PluginUiTargetedContributionSurfacePresentationV1;

/** Target-owned embedded surface contract; renderer selection remains with `ui.renderers`. */
export const PluginTargetedContributionSurfaceV1Schema = z.object({
  required: z.boolean(),
  inputSchema: PluginJsonSchemaV2Schema,
  presentation: PluginTargetedContributionSurfacePresentationV1Schema,
}).strict();
export type PluginTargetedContributionSurfaceV1 = z.infer<typeof PluginTargetedContributionSurfaceV1Schema>;

export const PluginContributionPointProtocolV1Schema = z.object({
  id: asProtocolZod(PluginContributionProtocolIdV1Schema),
  version: TargetedContributionProtocolVersionSchema,
  descriptor: PluginJsonSchemaV2Schema.optional(),
  operations: boundedOperationMap(PluginTargetedContributionOperationV1Schema),
  surfaces: boundedSurfaceMap(PluginTargetedContributionSurfaceV1Schema).optional(),
}).strict().superRefine((protocol, ctx) => {
  if (Object.keys(protocol.operations).length === 0 && Object.keys(protocol.surfaces ?? {}).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A contribution protocol must declare at least one operation or Surface role.',
    });
  }
});
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
  const descriptor = protocol.descriptor === undefined
    ? undefined
    : rehydrateCanonicalProtocolComposableSchema(protocol.descriptor);
  if (descriptor === null) return null;

  const operations: RehydratedPluginContributionPointOperationV1[] = [];
  for (const role of Object.keys(protocol.operations).sort()) {
    const operation = protocol.operations[role]!;
    const input = operation.input.kind === 'contributorDefined'
      ? Object.freeze({ kind: 'contributorDefined' as const })
      : (() => {
        const schema = rehydrateCanonicalProtocolComposableSchema(operation.input.schema);
        return schema === null
          ? null
          : Object.freeze({ kind: 'protocolDefined' as const, schema });
      })();
    const resultSchema = rehydrateCanonicalProtocolComposableSchema(operation.resultSchema);
    if (input === null || resultSchema === null) return null;
    operations.push(Object.freeze({ role, input, resultSchema }));
  }

  const surfaces: RehydratedPluginContributionPointSurfaceV1[] = [];
  for (const role of Object.keys(protocol.surfaces ?? {}).sort()) {
    const surface = protocol.surfaces?.[role];
    if (!surface || rehydrateCanonicalProtocolComposableSchema(surface.inputSchema) === null) return null;
    surfaces.push(Object.freeze({ role, presentation: surface.presentation }));
  }

  return Object.freeze({
    ...(descriptor === undefined ? {} : { descriptor }),
    operations: Object.freeze(operations),
    surfaces: Object.freeze(surfaces),
  });
}

export const PluginContributionPointV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  maxContributionsPerContributor: z.number().int().positive().safe()
    .max(TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_POINT)
    .optional(),
  protocols: z.array(PluginContributionPointProtocolV1Schema)
    .min(1)
    .max(PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1),
}).strict().superRefine((point, ctx) => {
  const seen = new Set<string>();
  point.protocols.forEach((protocol, index) => {
    const key = `${protocol.id}/${protocol.version}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocols', index],
        message: 'Duplicate targeted contribution protocol identity.',
      });
    }
    seen.add(key);
  });
});
export type PluginContributionPointV1 = z.infer<typeof PluginContributionPointV1Schema>;

export const PluginTargetedContributionTargetV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  pointId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type PluginTargetedContributionTargetV1 = z.infer<typeof PluginTargetedContributionTargetV1Schema>;

export const PluginTargetedContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  target: PluginTargetedContributionTargetV1Schema,
  protocol: PluginTargetedContributionProtocolV1Schema,
  descriptor: PluginJsonValueV2Schema.optional(),
  operations: boundedOperationMap(asProtocolZod(PluginContributionLocalIdSchema)),
  surfaces: boundedSurfaceMap(PluginUiRendererChainBindingV1Schema).optional(),
}).strict().superRefine((contribution, ctx) => {
  if (Object.keys(contribution.operations).length === 0 && Object.keys(contribution.surfaces ?? {}).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A targeted contribution must bind at least one operation or Surface role.',
    });
  }
});
export type PluginTargetedContributionV1 = z.infer<typeof PluginTargetedContributionV1Schema>;

/**
 * Manifest-local bounds which do not need a target plugin. Target presence,
 * role qualification, and active-snapshot limits stay with catalog admission.
 */
export function validateTargetedContributionEnvelopeBoundsV1(
  value: Readonly<{
    pluginContributionPoints: readonly PluginContributionPointV1[];
    targetedPluginContributions: readonly PluginTargetedContributionV1[];
  }>,
  ctx: z.RefinementCtx,
): void {
  const pointSchemaBytes = value.pluginContributionPoints.reduce((total, point) => (
    total + utf8Length(JSON.stringify(point.protocols.map((protocol) => ({
      id: protocol.id,
      version: protocol.version,
      descriptor: protocol.descriptor,
      operations: protocol.operations,
      surfaces: protocol.surfaces,
    }))))
  ), 0);
  if (pointSchemaBytes > TARGETED_CONTRIBUTION_MAX_POINT_SCHEMA_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pluginContributionPoints'],
      message: `Targeted contribution point schemas exceed the ${TARGETED_CONTRIBUTION_MAX_POINT_SCHEMA_BYTES}-byte limit.`,
    });
  }
  if (value.pluginContributionPoints.length > TARGETED_CONTRIBUTION_MAX_POINTS_PER_PLUGIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pluginContributionPoints'],
      message: `At most ${TARGETED_CONTRIBUTION_MAX_POINTS_PER_PLUGIN} targeted contribution points are allowed.`,
    });
  }
  if (value.targetedPluginContributions.length > TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_PLUGIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetedPluginContributions'],
      message: `At most ${TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_PLUGIN} targeted contributions are allowed.`,
    });
  }
  const targets = new Set<string>();
  const contributionsByPoint = new Map<string, number>();
  value.targetedPluginContributions.forEach((contribution, index) => {
    if (contribution.descriptor !== undefined
      && utf8Length(JSON.stringify(contribution.descriptor)) > TARGETED_CONTRIBUTION_MAX_DESCRIPTOR_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetedPluginContributions', index, 'descriptor'],
        message: `A targeted contribution descriptor may not exceed ${TARGETED_CONTRIBUTION_MAX_DESCRIPTOR_BYTES} bytes.`,
      });
    }
    targets.add(contribution.target.pluginId);
    const pointKey = `${contribution.target.pluginId}/${contribution.target.pointId}`;
    const count = (contributionsByPoint.get(pointKey) ?? 0) + 1;
    contributionsByPoint.set(pointKey, count);
    if (count > TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_POINT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetedPluginContributions', index],
        message: `At most ${TARGETED_CONTRIBUTION_MAX_CONTRIBUTIONS_PER_POINT} targeted contributions may bind one target point.`,
      });
    }
  });
  if (targets.size > TARGETED_CONTRIBUTION_MAX_TARGET_PLUGINS_PER_CONTRIBUTOR) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetedPluginContributions'],
      message: `At most ${TARGETED_CONTRIBUTION_MAX_TARGET_PLUGINS_PER_CONTRIBUTOR} target plugins may be named.`,
    });
  }
}
