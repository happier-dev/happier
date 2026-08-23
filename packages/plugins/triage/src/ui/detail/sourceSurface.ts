import type {
  PluginUiTargetedContributionSurfaceV1,
  PluginUiTargetedContributionV1,
  PluginUiTargetedContributionsV1,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  type TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The optional source-owned local materialization role of the V1 contract
 * (`packages/triage-protocol/src/v1/contribution.ts`). A source that leaves it
 * unbound cannot prepare a review workspace, which is a fact the header states
 * before a press rather than after one.
 */
const TRIAGE_PREPARE_REVIEW_WORKSPACE_ROLE_V1 = 'prepareReviewWorkspace';

/**
 * The one place the aggregate turns "this row belongs to that source" into the
 * exact admitted contribution handle its detail body mounts through.
 *
 * The mounted host already hands every surface its target-filtered admission
 * snapshot, and `TargetedSurface` accepts exactly the value that snapshot
 * carries. So this file MATCHES — it never constructs a handle, never names a
 * renderer or an artifact, and never decides whether a mount is possible: the
 * physical host owns that, and the fallback the caller supplies is what a
 * reader sees when it refuses (`core/SURFACE.md` §2.3).
 *
 * Matching is exact on all four identities. The point id, the protocol id and
 * its version come from the published contract; the contributor is the entry
 * reference's own `source`, whose `localId` IS the contribution id the source
 * declared. A looser match — first contribution at the point, or first
 * contributor with that plugin id at any protocol — would mount one source's
 * renderer under another source's entry.
 *
 * **It deliberately decodes nothing.** The snapshot also carries each
 * contributor's `descriptor`, and the semantic projection of that value belongs
 * to the SDK owner, which parses it with this target's own schema during cold
 * admission. The one reader that needs the result — §2.2's common header — gets
 * it typed from `entries/read-detail-v1`, never from a branch on snapshot bytes
 * here. Comparing published identity strings is not that projection: no meaning
 * is decoded, and every value compared is one the host already published as
 * identity.
 */

export type TriageSourceDetailContributionLookupV1 =
  | Readonly<{ kind: 'admitted'; surface: PluginUiTargetedContributionSurfaceV1 }>
  /** No current admitted V1 contribution from that source declares a detail surface. */
  | Readonly<{ kind: 'absent' }>;

const ABSENT: TriageSourceDetailContributionLookupV1 = Object.freeze({ kind: 'absent' });

/**
 * The one four-identity match. Every projection below reads its result rather
 * than walking the snapshot again: two walks are two chances to disagree about
 * which contribution answers for one entry.
 */
function findTriageSourceContributionV1(
  targetedContributions: PluginUiTargetedContributionsV1,
  source: TriageEntryRefV1['source'],
): PluginUiTargetedContributionV1 | undefined {
  const point = targetedContributions.points.find(
    (candidate) => candidate.pointId === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  );
  const snapshot = point?.protocols.find(
    (candidate) => candidate.protocol.id === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1
      && candidate.protocol.version === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  );
  return snapshot?.contributions.find(
    (candidate) => candidate.contributor.pluginId === source.pluginId
      && candidate.contributor.contributionId === source.localId,
  );
}

export function resolveTriageSourceDetailContributionV1(
  targetedContributions: PluginUiTargetedContributionsV1,
  source: TriageEntryRefV1['source'],
): TriageSourceDetailContributionLookupV1 {
  const surface = findTriageSourceContributionV1(targetedContributions, source)
    ?.surfaces.find((candidate) => candidate.role === TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1);
  return surface === undefined ? ABSENT : Object.freeze({ kind: 'admitted', surface });
}

/**
 * Whether the same admitted contribution binds the optional review-workspace
 * preparation operation.
 *
 * This is the header's ONE source of the capability. It is read from the
 * admitted contribution's declared operation roles — which the host already
 * published as identity — and never from a source id, a plugin name, a
 * descriptor, or a guess about what a forge probably supports. A source that
 * binds nothing here cannot prepare a worktree, so the control that needs one is
 * disabled with a stated reason instead of failing after the press.
 */
export function resolveTriageSourcePreparesReviewWorkspaceV1(
  targetedContributions: PluginUiTargetedContributionsV1,
  source: TriageEntryRefV1['source'],
): boolean {
  return findTriageSourceContributionV1(targetedContributions, source)
    ?.operations.some(
      (candidate) => candidate.role === TRIAGE_PREPARE_REVIEW_WORKSPACE_ROLE_V1,
    ) === true;
}

/** The same lookup, read from the mount's own host-stamped surface context. */
export function readTriageSourceDetailContributionV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
): TriageSourceDetailContributionLookupV1 {
  return resolveTriageSourceDetailContributionV1(context.targetedContributions, source);
}

/** The same capability, read from the mount's own host-stamped surface context. */
export function readTriageSourcePreparesReviewWorkspaceV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
): boolean {
  return resolveTriageSourcePreparesReviewWorkspaceV1(context.targetedContributions, source);
}
