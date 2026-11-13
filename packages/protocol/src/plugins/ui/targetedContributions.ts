import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
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
import {
  PluginSourceCustodyV1ProtocolSchema,
  pluginSourceCustodyV1Equal,
  type PluginSourceCustodyV1,
} from '../runtime/sourceCustody.js';
import type { PluginUiInstanceKeyV1 } from './semanticCommands.js';
import type { JsonValue } from '../../json/strictJsonValue.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from './runtimeOccurrenceV1.js';
export { PluginUiImmutableGenerationIdV1Schema, PluginUiRuntimeOccurrenceIdV1Schema } from './runtimeOccurrenceV1.js';
export type { PluginUiImmutableGenerationIdV1, PluginUiRuntimeOccurrenceIdV1 } from './runtimeOccurrenceV1.js';

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

export const PluginUiTargetedContributionTargetV1Schema = defineProtocolObject({
  pluginId: PluginIdSchema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  sourceCustody: PluginSourceCustodyV1ProtocolSchema,
}, { policy: 'closed' });
const PluginUiTargetedContributionTargetV1ZodSchema = asProtocolZod(
  PluginUiTargetedContributionTargetV1Schema,
);

export const PluginUiTargetedContributionContributorV1Schema = defineProtocolObject({
  pluginId: PluginIdSchema,
  contributionId: PluginContributionLocalIdSchema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  sourceCustody: PluginSourceCustodyV1ProtocolSchema,
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
const PluginUiTargetedContributionSelectionTargetV1Schema = defineProtocolObject({
  pluginId: PluginIdSchema,
  sourceCustody: PluginSourceCustodyV1ProtocolSchema,
}, { policy: 'closed' });

const PluginUiTargetedContributionSelectionContributorV1Schema = defineProtocolObject({
  pluginId: PluginIdSchema,
  contributionId: PluginContributionLocalIdSchema,
  sourceCustody: PluginSourceCustodyV1ProtocolSchema,
}, { policy: 'closed' });

export const PluginTargetedContributionSelectionV1Schema = defineProtocolObject({
  target: PluginUiTargetedContributionSelectionTargetV1Schema,
  point: PluginUiTargetedContributionPointRefV1Schema,
  contributor: PluginUiTargetedContributionSelectionContributorV1Schema,
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
export const PluginUiTargetedContributionOperationV1Schema = lazyZodSchema(() => z.strictObject({
  point: PluginUiTargetedContributionPointRefV1ZodSchema,
  contributor: PluginUiTargetedContributionContributorV1ZodSchema,
  role: PluginContributionOperationRoleV1Schema,
  action: PluginContributionIdentityV1ZodSchema,
}));
export type PluginUiTargetedContributionOperationV1 = z.infer<
  typeof PluginUiTargetedContributionOperationV1Schema
>;

/** The target-owned non-navigable presentation contract of one admitted Surface role. */
export const PluginUiTargetedContributionSurfacePresentationV1Schema = lazyZodSchema(() => z.enum(['content', 'fill']));
export type PluginUiTargetedContributionSurfacePresentationV1 = z.infer<
  typeof PluginUiTargetedContributionSurfacePresentationV1Schema
>;

/**
 * One exact admitted embedded Surface handle projected to the mounted target.
 * It is data-only: role input schema and renderer selection stay host-private.
 */
export const PluginUiTargetedContributionSurfaceV1Schema = lazyZodSchema(() => z.strictObject({
  point: PluginUiTargetedContributionPointRefV1ZodSchema,
  contributor: PluginUiTargetedContributionContributorV1ZodSchema,
  role: PluginContributionLocalIdZodSchema,
  presentation: PluginUiTargetedContributionSurfacePresentationV1Schema,
}));
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

export const PluginUiTargetedContributionV1Schema = lazyZodSchema(() => z.strictObject({
  contributor: PluginUiTargetedContributionContributorV1ZodSchema,
  protocol: PluginUiTargetedContributionProtocolV1ZodSchema,
  /** Normalized target-owned descriptor, present only when its protocol declares one. */
  descriptor: z.optional(PluginJsonValueV2Schema),
  operations: z.array(PluginUiTargetedContributionOperationV1Schema).check(z.maxLength(PLUGIN_UI_TARGETED_CONTRIBUTION_OPERATIONS_MAX_V1)),
  /** The current projection always carries an explicit (possibly empty) Surface family. */
  surfaces: z.array(PluginUiTargetedContributionSurfaceV1Schema).check(z.maxLength(PLUGIN_UI_TARGETED_CONTRIBUTION_SURFACES_MAX_V1)),
}).check(z.superRefine((contribution, ctx) => {
  const roles = new Set<string>();
  contribution.operations.forEach((operation, index) => {
    if (roles.has(operation.role)) {
      ctx.addIssue({
        code: "custom",
        path: ['operations', index, 'role'],
        message: 'Targeted contribution roles must be unique within one contributor record.',
      });
    }
    roles.add(operation.role);
    if (operation.action.pluginId !== contribution.contributor.pluginId) {
      ctx.addIssue({
        code: "custom",
        path: ['operations', index, 'action', 'pluginId'],
        message: 'A targeted operation Action must belong to its admitted contributor.',
      });
    }
    if (
      operation.contributor.pluginId !== contribution.contributor.pluginId
      || operation.contributor.contributionId !== contribution.contributor.contributionId
      || !operation.contributor.sourceCustody
      || !contribution.contributor.sourceCustody
      || (operation.contributor.occurrenceId === contribution.contributor.occurrenceId && !pluginSourceCustodyV1Equal(
        operation.contributor.sourceCustody,
        contribution.contributor.sourceCustody,
      ))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ['operations', index, 'contributor'],
        message: 'A targeted operation must carry its exact admitted contributor identity.',
      });
    }
  });
  const surfaceRoles = new Set<string>();
  contribution.surfaces.forEach((surface, index) => {
    if (surfaceRoles.has(surface.role)) {
      ctx.addIssue({
        code: "custom",
        path: ['surfaces', index, 'role'],
        message: 'Targeted Surface roles must be unique within one contributor record.',
      });
    }
    surfaceRoles.add(surface.role);
    if (
      surface.contributor.pluginId !== contribution.contributor.pluginId
      || surface.contributor.contributionId !== contribution.contributor.contributionId
      || !surface.contributor.sourceCustody
      || !contribution.contributor.sourceCustody
      || (surface.contributor.occurrenceId === contribution.contributor.occurrenceId && !pluginSourceCustodyV1Equal(
        surface.contributor.sourceCustody,
        contribution.contributor.sourceCustody,
      ))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ['surfaces', index, 'contributor'],
        message: 'A targeted Surface must carry its exact admitted contributor identity.',
      });
    }
  });
})));
export type PluginUiTargetedContributionV1 = z.infer<
  typeof PluginUiTargetedContributionV1Schema
>;

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function contributorSortKey(contributor: PluginUiTargetedContributionV1['contributor']): string {
  return [contributor.pluginId, contributor.contributionId, contributor.occurrenceId].join('\u0000');
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
export const PluginUiTargetedContributionProtocolSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  protocol: PluginUiTargetedContributionProtocolV1ZodSchema,
  contributions: z.array(PluginUiTargetedContributionV1Schema).check(z.maxLength(PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1)),
}).check(z.superRefine((point, ctx) => {
  let previousContributorKey: string | undefined;
  point.contributions.forEach((contribution, index) => {
    if (!sameProtocol(contribution.protocol, point.protocol)) {
      ctx.addIssue({
        code: "custom",
        path: ['contributions', index, 'protocol'],
        message: 'A targeted contribution must use its point snapshot protocol.',
      });
    }
    const key = contributorSortKey(contribution.contributor);
    if (previousContributorKey !== undefined && compareText(previousContributorKey, key) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ['contributions', index],
        message: 'Targeted contributions must be uniquely and deterministically sorted.',
      });
    }
    previousContributorKey = key;
  });
})));
/**
 * The published projection is immutable: readers keep row identity across re-reads (frozen,
 * structurally shared rows), and no consumer mutates it. Parsed wire values assign to it.
 */
export type PluginUiTargetedContributionProtocolSnapshotV1 = Readonly<Omit<z.infer<
  typeof PluginUiTargetedContributionProtocolSnapshotV1Schema
>, 'contributions'> & { contributions: readonly PluginUiTargetedContributionV1[] }>;

/**
 * One target-declared point and all of its accepted protocol epochs. Grouping
 * prevents a point's version bound from silently consuming the point bound.
 */
export const PluginUiTargetedContributionPointSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  pointId: PluginContributionLocalIdZodSchema,
  protocols: z.array(PluginUiTargetedContributionProtocolSnapshotV1Schema).check(z.minLength(1), z.maxLength(PLUGIN_UI_TARGETED_CONTRIBUTION_PROTOCOLS_MAX_V1)),
}).check(z.superRefine((point, ctx) => {
  let aggregateContributionCount = 0;
  let previous: PluginUiTargetedContributionProtocolV1 | undefined;
  point.protocols.forEach((snapshot, index) => {
    if (previous !== undefined && compareProtocol(previous, snapshot.protocol) >= 0) {
      ctx.addIssue({
        code: "custom",
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
            code: "custom",
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
            code: "custom",
            path: ['protocols', index, 'contributions', contributionIndex, 'surfaces', surfaceIndex, 'point'],
            message: 'A targeted Surface must name its exact admitted point and protocol.',
          });
        }
      });
    });
  });
  if (aggregateContributionCount > PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1) {
    ctx.addIssue({
      code: "custom",
      path: ['protocols'],
      message: 'A targeted point cannot expose more than the aggregate contributor ceiling.',
    });
  }
})));
export type PluginUiTargetedContributionPointSnapshotV1 = Readonly<Omit<z.infer<
  typeof PluginUiTargetedContributionPointSnapshotV1Schema
>, 'protocols'> & { protocols: readonly PluginUiTargetedContributionProtocolSnapshotV1[] }>;

/**
 * The immutable, target-filtered admission projection carried in a Host API
 * surface context. It intentionally exposes one mounted target only: no
 * arbitrary target selector, global catalog, diagnostics, candidates, or
 * runtime materialization facts cross this boundary. A normalized descriptor
 * may cross only on its owning admitted contribution; renderer and input-schema
 * facts remain host-private.
 */
export const PluginUiTargetedContributionsV1Schema = lazyZodSchema(() => z.strictObject({
  target: PluginUiTargetedContributionTargetV1ZodSchema,
  points: z.array(PluginUiTargetedContributionPointSnapshotV1Schema).check(z.maxLength(PLUGIN_UI_TARGETED_CONTRIBUTION_POINTS_MAX_V1)),
}).check(z.superRefine((snapshot, ctx) => {
  let previousPointId: string | undefined;
  snapshot.points.forEach((point, index) => {
    if (previousPointId !== undefined && compareText(previousPointId, point.pointId) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ['points', index],
        message: 'Targeted points must be uniquely and deterministically sorted.',
      });
    }
    previousPointId = point.pointId;
  });
})));
export type PluginUiTargetedContributionsV1 = Readonly<Omit<z.infer<
  typeof PluginUiTargetedContributionsV1Schema
>, 'points'> & { points: readonly PluginUiTargetedContributionPointSnapshotV1[] }>;

type TargetedContributorIdentity = Readonly<{
  pluginId: string;
  contributionId: string;
  occurrenceId: string;
}>;

/** Host-private semantic facts already validated by targeted admission. */
export type PluginUiTargetedContributionSemanticSnapshotV1 = Readonly<{
  point: PluginUiTargetedContributionPointRefV1;
  snapshot: Readonly<{
    target: Readonly<{ pluginId: string; pointId: string; occurrenceId: string }>;
    contributions: readonly Readonly<{
      contributor: TargetedContributorIdentity;
      protocol: PluginUiTargetedContributionProtocolV1;
      descriptor?: JsonValue;
      operations: readonly Readonly<{
        role: string;
        action: Readonly<{ pluginId: string; localId: string }>;
        contributor: TargetedContributorIdentity;
      }>[];
      surfaces: readonly Readonly<{
        role: string;
        presentation: PluginUiTargetedContributionSurfacePresentationV1;
        contributor: TargetedContributorIdentity;
      }>[];
    }>[];
  }>;
}>;

type ReadTargetedSourceCustody = (
  pluginId: string,
  occurrenceId: string,
) => PluginSourceCustodyV1 | null | undefined;

/** Resolves exact physical custody without making an admission/currentness decision. */
export function projectPluginUiTargetedContributionIdentityV1<
  TIdentity extends Readonly<{ pluginId: string; occurrenceId: string }>,
>(input: Readonly<{
  identity: TIdentity;
  readSourceCustody: ReadTargetedSourceCustody;
}>): TIdentity & Readonly<{ sourceCustody: PluginSourceCustodyV1 }> {
  const sourceCustody = input.readSourceCustody(input.identity.pluginId, input.identity.occurrenceId);
  if (!sourceCustody) {
    throw new TypeError(`Targeted contribution source custody is unavailable for '${input.identity.pluginId}'`);
  }
  return Object.freeze({ ...input.identity, sourceCustody });
}

/**
 * The shared semantic projection for Account and Machine mounts. Admission owns
 * selection; this only projects its exact identities through the strict public
 * consumer, leaving private parsers, renderers and execution handles behind.
 */
export function projectPluginUiTargetedContributionsV1(input: Readonly<{
  target: Readonly<{ pluginId: string; occurrenceId: string }>;
  snapshots: readonly PluginUiTargetedContributionSemanticSnapshotV1[];
  readSourceCustody: ReadTargetedSourceCustody;
}>): PluginUiTargetedContributionsV1 {
  const projectIdentity = <TIdentity extends Readonly<{ pluginId: string; occurrenceId: string }>>(
    identity: TIdentity,
  ) => projectPluginUiTargetedContributionIdentityV1({ identity, readSourceCustody: input.readSourceCustody });
  const pointsById = new Map<string, PluginUiTargetedContributionSemanticSnapshotV1[]>();
  for (const snapshot of input.snapshots) {
    const existing = pointsById.get(snapshot.point.pointId);
    if (existing) existing.push(snapshot);
    else pointsById.set(snapshot.point.pointId, [snapshot]);
  }
  const points = [...pointsById.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([pointId, snapshots]) => ({
      pointId,
      protocols: snapshots.map(({ point, snapshot }) => ({
        protocol: { ...point.protocol },
        contributions: snapshot.contributions.map((contribution) => ({
          contributor: projectIdentity(contribution.contributor),
          protocol: { ...contribution.protocol },
          ...(contribution.descriptor === undefined ? {} : { descriptor: contribution.descriptor }),
          operations: contribution.operations.map((operation) => ({
            point: { pointId: point.pointId, protocol: { ...point.protocol } },
            contributor: projectIdentity(operation.contributor),
            role: operation.role,
            action: { ...operation.action },
          })),
          surfaces: contribution.surfaces.map((surface) => ({
            point: { pointId: point.pointId, protocol: { ...point.protocol } },
            contributor: projectIdentity(surface.contributor),
            role: surface.role,
            presentation: surface.presentation,
          })),
        })).sort((left, right) => compareText(contributorSortKey(left.contributor), contributorSortKey(right.contributor))),
      })),
    }));
  return PluginUiTargetedContributionsV1Schema.parse({ target: projectIdentity(input.target), points });
}

/**
 * The identity a target already knows about one contribution it can consume:
 * its own point, the protocol epoch it declared, and the contributor its own
 * domain selected. Generation is not an input — the mounted snapshot is
 * already exactly one target-filtered current occurrence.
 */
export type PluginUiTargetedContributionSelectorV1 = Readonly<{
  pointId: string;
  protocol: Readonly<{ id: string; version: number }>;
  contributor: Readonly<{ pluginId: string; contributionId: string }>;
}>;

function sameTargetedProtocol(
  left: Readonly<{ id: string; version: number }>,
  right: Readonly<{ id: string; version: number }>,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function exactlyOne<TValue>(values: readonly TValue[]): TValue | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Selects the one admitted contribution a target-local snapshot exposes for an
 * exact point/protocol-epoch/contributor identity, returning the original
 * admitted object so it can be handed straight back to the host.
 *
 * This is a pure lookup: it performs no IO, owns no currentness, creates no
 * service, and re-parses nothing — the snapshot schema above already rejects
 * duplicate or drifting identities before an author sees it. Ambiguity still
 * fails closed rather than picking a first entry, because "some contributor at
 * that point" is never the answer a domain-selected lookup wanted.
 */
export function selectPluginUiTargetedContributionV1(
  targetedContributions: PluginUiTargetedContributionsV1,
  selector: PluginUiTargetedContributionSelectorV1,
): PluginUiTargetedContributionV1 | undefined {
  return exactlyOne(targetedContributions.points.flatMap((point) => (
    point.pointId !== selector.pointId
      ? []
      : point.protocols.flatMap((protocolSnapshot) => (
        !sameTargetedProtocol(protocolSnapshot.protocol, selector.protocol)
          ? []
          : protocolSnapshot.contributions.filter((contribution) => (
            sameTargetedProtocol(contribution.protocol, selector.protocol)
            && contribution.contributor.pluginId === selector.contributor.pluginId
            && contribution.contributor.contributionId === selector.contributor.contributionId
          ))
      ))
  )));
}

function selectAdmittedRoleEntry<
  TEntry extends Readonly<{
    point: PluginUiTargetedContributionPointRefV1;
    contributor: Readonly<{
      pluginId: string;
      contributionId: string;
      occurrenceId: string;
    }>;
    role: string;
  }>,
>(
  entries: readonly TEntry[],
  contribution: PluginUiTargetedContributionV1,
  selector: PluginUiTargetedContributionSelectorV1 & Readonly<{ role: string }>,
): TEntry | undefined {
  return exactlyOne(entries.filter((entry) => (
    entry.role === selector.role
    && entry.point.pointId === selector.pointId
    && sameTargetedProtocol(entry.point.protocol, selector.protocol)
    && entry.contributor.pluginId === contribution.contributor.pluginId
    && entry.contributor.contributionId === contribution.contributor.contributionId
  )));
}

/** The admitted surface an exact contributor binds to one target-owned surface role. */
export function selectPluginUiTargetedContributionSurfaceV1(
  targetedContributions: PluginUiTargetedContributionsV1,
  selector: PluginUiTargetedContributionSelectorV1 & Readonly<{ role: string }>,
): PluginUiTargetedContributionSurfaceV1 | undefined {
  const contribution = selectPluginUiTargetedContributionV1(targetedContributions, selector);
  return contribution === undefined
    ? undefined
    : selectAdmittedRoleEntry(contribution.surfaces, contribution, selector);
}

/** The admitted operation an exact contributor binds to one target-owned operation role. */
export function selectPluginUiTargetedContributionOperationV1(
  targetedContributions: PluginUiTargetedContributionsV1,
  selector: PluginUiTargetedContributionSelectorV1 & Readonly<{ role: string }>,
): PluginUiTargetedContributionOperationV1 | undefined {
  const contribution = selectPluginUiTargetedContributionV1(targetedContributions, selector);
  return contribution === undefined
    ? undefined
    : selectAdmittedRoleEntry(contribution.operations, contribution, selector);
}
