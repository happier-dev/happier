import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
} from '../actions/protocolComposableSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
  PluginContributionOperationRoleV1Schema,
  PluginContributionProtocolIdV1Schema,
} from '../contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { PluginIdSchema } from '../pluginId.js';
import type { PluginUiInstanceKeyV1 } from './semanticCommands.js';

/** One mounted target can expose at most this many admitted contributors. */
export const PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1 = 256;
/** One contributor/protocol record can expose at most this many exact roles. */
export const PLUGIN_UI_TARGETED_CONTRIBUTION_OPERATIONS_MAX_V1 = 16;
/** One contributor/protocol record can expose at most this many embedded Surface roles. */
export const PLUGIN_UI_TARGETED_CONTRIBUTION_SURFACES_MAX_V1 = 16;
/** One mounted target can expose at most this many declared point/protocol snapshots. */
export const PLUGIN_UI_TARGETED_CONTRIBUTION_POINTS_MAX_V1 = 16;
/** One admitted point can expose at most this many accepted protocol versions. */
export const PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1 = 4;

/**
 * A committed plugin-generation identity from admission. This is deliberately
 * separate from `PluginMachineMaterializationIdV1`: cold bundled contributors
 * have no runtime materialization, while their committed generation remains
 * the authority that selection and later execution must preserve.
 */
const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

export const PluginUiImmutableGenerationIdV1Schema = defineProtocolString({
  minLength: 1,
  maxLength: 256,
  pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
export type PluginUiImmutableGenerationIdV1 = ReturnType<typeof PluginUiImmutableGenerationIdV1Schema.parse>;

const PluginUiTargetedContributionTargetV1Schema = defineProtocolObject({
  pluginId: PluginIdSchema,
  immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
}, { policy: 'closed' });
const PluginUiTargetedContributionTargetV1ZodSchema = asProtocolZod(
  PluginUiTargetedContributionTargetV1Schema,
);

const PluginUiTargetedContributionContributorV1Schema = defineProtocolObject({
  pluginId: PluginIdSchema,
  contributionId: PluginContributionLocalIdSchema,
  immutableGenerationId: PluginUiImmutableGenerationIdV1Schema,
}, { policy: 'closed' });
const PluginUiTargetedContributionContributorV1ZodSchema = asProtocolZod(
  PluginUiTargetedContributionContributorV1Schema,
);

export const PluginUiTargetedContributionProtocolV1Schema = defineProtocolObject({
  id: PluginContributionProtocolIdV1Schema,
  version: defineProtocolNumber({ integer: true, minimum: 1 }),
}, { policy: 'closed' });
const PluginUiTargetedContributionProtocolV1ZodSchema = asProtocolZod(
  PluginUiTargetedContributionProtocolV1Schema,
);
export type PluginUiTargetedContributionProtocolV1 = ReturnType<typeof PluginUiTargetedContributionProtocolV1Schema.parse>;

/**
 * A point/protocol identity within the target already bound to this surface.
 * It intentionally excludes a target plugin selector: the ambient Host API
 * context supplies exactly one immutable target.
 */
export const PluginUiTargetedContributionPointRefV1Schema = defineProtocolObject({
  pointId: PluginContributionLocalIdSchema,
  protocol: PluginUiTargetedContributionProtocolV1Schema,
}, { policy: 'closed' });
const PluginUiTargetedContributionPointRefV1ZodSchema = asProtocolZod(
  PluginUiTargetedContributionPointRefV1Schema,
);
export type PluginUiTargetedContributionPointRefV1 = ReturnType<typeof PluginUiTargetedContributionPointRefV1Schema.parse>;

/**
 * The portable identity of one host-validated admitted contribution selection.
 *
 * This value deliberately carries neither an Action nor a role. It can identify
 * the exact target, point epoch, and contributor selected by the mounted host,
 * but it does not authorize a caller to look up or invoke an Action outside the
 * host-private selected-operation association.
 */
export const PluginTargetedContributionSelectionV1Schema = defineProtocolObject({
  target: PluginUiTargetedContributionTargetV1Schema,
  point: PluginUiTargetedContributionPointRefV1Schema,
  contributor: PluginUiTargetedContributionContributorV1Schema,
}, { policy: 'closed' });
export type PluginTargetedContributionSelectionV1 = ReturnType<typeof PluginTargetedContributionSelectionV1Schema.parse>;

const PluginContributionIdentityV1ZodSchema = asProtocolZod(PluginContributionIdentityV1Schema);
const PluginContributionLocalIdZodSchema = asProtocolZod(PluginContributionLocalIdSchema);

/**
 * One exact admitted Action operation projected to a mounted target UI.
 *
 * `point` is part of the opaque admission handle rather than a caller-owned
 * selection field. This is a host-stamped currentness expectation, not
 * author-supplied provenance or Action input. The host matches it to the
 * mounted target snapshot before opening a no-invoke form, then preserves the
 * same expected contributor generation for the canonical Action dispatcher.
 */
export const PluginUiTargetedContributionOperationV1Schema = z.object({
  point: PluginUiTargetedContributionPointRefV1ZodSchema,
  contributor: PluginUiTargetedContributionContributorV1ZodSchema,
  role: PluginContributionOperationRoleV1Schema,
  action: PluginContributionIdentityV1ZodSchema,
}).strict();
export type PluginUiTargetedContributionOperationV1 = z.infer<
  typeof PluginUiTargetedContributionOperationV1Schema
>;

/** The target-owned non-navigable presentation contract of one admitted Surface role. */
export const PluginUiTargetedContributionSurfacePresentationV1Schema = z.enum(['content', 'fill']);
export type PluginUiTargetedContributionSurfacePresentationV1 = z.infer<
  typeof PluginUiTargetedContributionSurfacePresentationV1Schema
>;

/**
 * One exact admitted embedded Surface handle projected to the mounted target.
 * It is data-only: role input schema and renderer selection stay host-private.
 */
export const PluginUiTargetedContributionSurfaceV1Schema = z.object({
  point: PluginUiTargetedContributionPointRefV1ZodSchema,
  contributor: PluginUiTargetedContributionContributorV1ZodSchema,
  role: PluginContributionLocalIdZodSchema,
  presentation: PluginUiTargetedContributionSurfacePresentationV1Schema,
}).strict();
export type PluginUiTargetedContributionSurfaceV1 = z.infer<
  typeof PluginUiTargetedContributionSurfaceV1Schema
>;

/**
 * The logical facts that distinguish one mounted targeted Surface from another.
 * The raw key is caller-local only; immutable generations are lifecycle fences
 * and deliberately do not create a new entry identity.
 */
export type PluginUiTargetedSurfaceMountInstanceIdentityV1 = Readonly<{
  targetPluginId: string;
  surface: PluginUiTargetedContributionSurfaceV1;
  rawInstanceKey?: PluginUiInstanceKeyV1;
}>;

/**
 * Produces the one browser-safe, opaque mount identity shared by React and
 * declarative targeted surfaces. SHA-256 bounds the composed key; it is not an
 * integrity, authorization, or persistence authority.
 */
export function derivePluginUiTargetedSurfaceMountInstanceKeyV1(
  input: PluginUiTargetedSurfaceMountInstanceIdentityV1,
): PluginUiInstanceKeyV1 {
  const namespace = JSON.stringify([
    input.targetPluginId,
    input.surface.point.pointId,
    input.surface.point.protocol.id,
    input.surface.point.protocol.version,
    input.surface.contributor.pluginId,
    input.surface.contributor.contributionId,
    input.surface.role,
    input.rawInstanceKey ?? null,
  ]);
  return `targeted-surface:v1:${bytesToHex(sha256(utf8ToBytes(namespace)))}`;
}

export const PluginUiTargetedContributionV1Schema = z.object({
  contributor: PluginUiTargetedContributionContributorV1ZodSchema,
  protocol: PluginUiTargetedContributionProtocolV1ZodSchema,
  /** Normalized target-owned descriptor, present only when its protocol declares one. */
  descriptor: PluginJsonValueV2Schema.optional(),
  operations: z.array(PluginUiTargetedContributionOperationV1Schema)
    .max(PLUGIN_UI_TARGETED_CONTRIBUTION_OPERATIONS_MAX_V1),
  /** The current projection always carries an explicit (possibly empty) Surface family. */
  surfaces: z.array(PluginUiTargetedContributionSurfaceV1Schema)
    .max(PLUGIN_UI_TARGETED_CONTRIBUTION_SURFACES_MAX_V1),
}).strict().superRefine((contribution, ctx) => {
  const roles = new Set<string>();
  contribution.operations.forEach((operation, index) => {
    if (roles.has(operation.role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'role'],
        message: 'Targeted contribution roles must be unique within one contributor record.',
      });
    }
    roles.add(operation.role);
    if (operation.action.pluginId !== contribution.contributor.pluginId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'action', 'pluginId'],
        message: 'A targeted operation Action must belong to its admitted contributor.',
      });
    }
    if (
      operation.contributor.pluginId !== contribution.contributor.pluginId
      || operation.contributor.contributionId !== contribution.contributor.contributionId
      || operation.contributor.immutableGenerationId !== contribution.contributor.immutableGenerationId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations', index, 'contributor'],
        message: 'A targeted operation must carry its exact admitted contributor identity.',
      });
    }
  });
  const surfaceRoles = new Set<string>();
  contribution.surfaces.forEach((surface, index) => {
    if (surfaceRoles.has(surface.role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surfaces', index, 'role'],
        message: 'Targeted Surface roles must be unique within one contributor record.',
      });
    }
    surfaceRoles.add(surface.role);
    if (
      surface.contributor.pluginId !== contribution.contributor.pluginId
      || surface.contributor.contributionId !== contribution.contributor.contributionId
      || surface.contributor.immutableGenerationId !== contribution.contributor.immutableGenerationId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['surfaces', index, 'contributor'],
        message: 'A targeted Surface must carry its exact admitted contributor identity.',
      });
    }
  });
});
export type PluginUiTargetedContributionV1 = z.infer<
  typeof PluginUiTargetedContributionV1Schema
>;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareProtocol(
  left: PluginUiTargetedContributionProtocolV1,
  right: PluginUiTargetedContributionProtocolV1,
): number {
  const id = compareText(left.id, right.id);
  return id === 0 ? left.version - right.version : id;
}

function sameProtocol(
  left: PluginUiTargetedContributionProtocolV1,
  right: PluginUiTargetedContributionProtocolV1,
): boolean {
  return left.id === right.id && left.version === right.version;
}

/**
 * One deterministic, cold-admitted protocol projection for a single target
 * point. A contributor cannot appear through a different protocol than this
 * exact accepted epoch.
 */
export const PluginUiTargetedContributionProtocolSnapshotV1Schema = z.object({
  protocol: PluginUiTargetedContributionProtocolV1ZodSchema,
  contributions: z.array(PluginUiTargetedContributionV1Schema)
    .max(PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1),
}).strict().superRefine((point, ctx) => {
  let previousContributorKey: string | undefined;
  point.contributions.forEach((contribution, index) => {
    if (!sameProtocol(contribution.protocol, point.protocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributions', index, 'protocol'],
        message: 'A targeted contribution must use its point snapshot protocol.',
      });
    }
    const key = [
      contribution.contributor.pluginId,
      contribution.contributor.contributionId,
      contribution.contributor.immutableGenerationId,
    ].join('\u0000');
    if (previousContributorKey !== undefined && compareText(previousContributorKey, key) >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributions', index],
        message: 'Targeted contributions must be uniquely and deterministically sorted.',
      });
    }
    previousContributorKey = key;
  });
});
export type PluginUiTargetedContributionProtocolSnapshotV1 = z.infer<
  typeof PluginUiTargetedContributionProtocolSnapshotV1Schema
>;

/**
 * One target-declared point and all of its accepted protocol epochs. Grouping
 * prevents a point's version bound from silently consuming the point bound.
 */
export const PluginUiTargetedContributionPointSnapshotV1Schema = z.object({
  pointId: PluginContributionLocalIdZodSchema,
  protocols: z.array(PluginUiTargetedContributionProtocolSnapshotV1Schema)
    .min(1)
    .max(PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1),
}).strict().superRefine((point, ctx) => {
  let aggregateContributionCount = 0;
  let previous: PluginUiTargetedContributionProtocolV1 | undefined;
  point.protocols.forEach((snapshot, index) => {
    if (previous !== undefined && compareProtocol(previous, snapshot.protocol) >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protocols', index],
        message: 'Targeted point protocols must be uniquely and deterministically sorted.',
      });
    }
    previous = snapshot.protocol;
    aggregateContributionCount += snapshot.contributions.length;
    snapshot.contributions.forEach((contribution, contributionIndex) => {
      contribution.operations.forEach((operation, operationIndex) => {
        if (
          operation.point.pointId !== point.pointId
          || !sameProtocol(operation.point.protocol, snapshot.protocol)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['protocols', index, 'contributions', contributionIndex, 'operations', operationIndex, 'point'],
            message: 'A targeted operation must name its exact admitted point and protocol.',
          });
        }
      });
      contribution.surfaces.forEach((surface, surfaceIndex) => {
        if (
          surface.point.pointId !== point.pointId
          || !sameProtocol(surface.point.protocol, snapshot.protocol)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['protocols', index, 'contributions', contributionIndex, 'surfaces', surfaceIndex, 'point'],
            message: 'A targeted Surface must name its exact admitted point and protocol.',
          });
        }
      });
    });
  });
  if (aggregateContributionCount > PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['protocols'],
      message: 'A targeted point cannot expose more than the aggregate contributor ceiling.',
    });
  }
});
export type PluginUiTargetedContributionPointSnapshotV1 = z.infer<
  typeof PluginUiTargetedContributionPointSnapshotV1Schema
>;

/**
 * The immutable, target-filtered admission projection carried in a Host API
 * surface context. It intentionally exposes one mounted target only: no
 * arbitrary target selector, global catalog, diagnostics, candidates, or
 * runtime materialization facts cross this boundary. A normalized descriptor
 * may cross only on its owning admitted contribution; renderer and input-schema
 * facts remain host-private.
 */
export const PluginUiTargetedContributionsV1Schema = z.object({
  target: PluginUiTargetedContributionTargetV1ZodSchema,
  points: z.array(PluginUiTargetedContributionPointSnapshotV1Schema)
    .max(PLUGIN_UI_TARGETED_CONTRIBUTION_POINTS_MAX_V1),
}).strict().superRefine((snapshot, ctx) => {
  let previousPointId: string | undefined;
  snapshot.points.forEach((point, index) => {
    if (previousPointId !== undefined && compareText(previousPointId, point.pointId) >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points', index],
        message: 'Targeted points must be uniquely and deterministically sorted.',
      });
    }
    previousPointId = point.pointId;
  });
});
export type PluginUiTargetedContributionsV1 = z.infer<
  typeof PluginUiTargetedContributionsV1Schema
>;
