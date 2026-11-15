import {
  selectTargetedContribution,
  selectTargetedContributionOperation,
  selectTargetedContributionSurface,
} from '@happier-dev/plugin-sdk/ui';
import type {
  PluginUiTargetedContributionOperationV1,
  PluginUiTargetedContributionSelectorV1,
  PluginUiTargetedContributionSurfaceV1,
  PluginUiTargetedContributionV1,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
  TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  admitTriageSourceDescriptorV1,
  type TriageEntryRefV1,
  type TriageSourceDescriptorV1,
  type TriageSourceKindGlyphV1,
  type TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';
import { renderSourceQualifiedId } from '../../corpus/identity/components.js';

/**
 * The optional source-owned local materialization role of the V1 contract
 * (`packages/triage-protocol/src/v1/contribution.ts`). A source that leaves it
 * unbound cannot prepare a review workspace, which is a fact the header states
 * before a press rather than after one.
 */
const TRIAGE_PREPARE_REVIEW_WORKSPACE_ROLE_V1 = 'prepareReviewWorkspace';
const TRIAGE_GET_SOURCE_ENTRY_ROLE_V1 = 'get';

/**
 * The one place the aggregate turns "this row belongs to that source" into the
 * exact admitted contribution handle its detail body mounts through.
 *
 * An executable mount receives its target-filtered admission snapshot;
 * Account-only presentation can have no admitted occurrence yet. Absence
 * means no source renderer, descriptor or operation, never a synthetic target.
 * `TargetedSurface` accepts exactly the value an admitted snapshot
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
 * **The matcher deliberately decodes nothing.** The projections below may use
 * the published protocol parser after that exact match, but the identity lookup
 * itself never guesses from descriptor contents. Comparing published identity
 * strings is not semantic projection: every value compared is one the host
 * already published as identity.
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
function triageSourceSelectorV1(
  source: TriageEntryRefV1['source'],
): PluginUiTargetedContributionSelectorV1 {
  return {
    pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    protocol: {
      id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
      version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    },
    contributor: { pluginId: source.pluginId, contributionId: source.localId },
  };
}

function findTriageSourceContributionV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
): PluginUiTargetedContributionV1 | undefined {
  return targetedContributions === undefined
    ? undefined
    : selectTargetedContribution(targetedContributions, triageSourceSelectorV1(source));
}

/**
 * The source descriptor from this mount's exact host-stamped snapshot.
 *
 * Descriptor presentation and operation/surface availability are one admitted
 * fact. Routing the descriptor through an own Action would take a second
 * daemon snapshot with a different generation and would also make otherwise
 * durable detail reads depend on a reachable daemon.
 */
export function resolveTriageSourceDescriptorV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
): TriageSourceDescriptorV1 | null {
  const contribution = findTriageSourceContributionV1(targetedContributions, source);
  if (contribution === undefined) return null;
  const admitted = admitTriageSourceDescriptorV1(contribution.descriptor);
  return admitted.ok ? admitted.descriptor : null;
}

export type TriageSourceDescriptorReaderV1 = (
  source: TriageEntryRefV1['source'],
) => TriageSourceDescriptorV1 | null;

/** Admit the current source vocabulary once; row projections consume its typed result. */
export function projectTriageSourceDescriptorsV1(
  targetedContributions: SurfaceContext['targetedContributions'],
): TriageSourceDescriptorReaderV1 {
  const descriptors = new Map<string, TriageSourceDescriptorV1 | null>();
  const point = targetedContributions?.points.find(candidate => candidate.pointId === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1);
  const protocol = point?.protocols.find(candidate => candidate.protocol.id === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1
    && candidate.protocol.version === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1);
  for (const contribution of protocol?.contributions ?? []) {
    const source = { pluginId: contribution.contributor.pluginId, localId: contribution.contributor.contributionId };
    descriptors.set(renderSourceQualifiedId(source), resolveTriageSourceDescriptorV1(targetedContributions, source));
  }
  return source => descriptors.get(renderSourceQualifiedId(source)) ?? null;
}

export function resolveTriageSourceDetailContributionV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
): TriageSourceDetailContributionLookupV1 {
  if (targetedContributions === undefined) return ABSENT;
  const surface = selectTargetedContributionSurface(targetedContributions, {
    ...triageSourceSelectorV1(source),
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
  });
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
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
): boolean {
  return resolveTriageSourcePrepareReviewWorkspaceOperationV1(targetedContributions, source) !== undefined;
}

/** Transport availability comes from the same exact admitted source snapshot. */
export function resolveTriageSourceSessionRelationsV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
  role: 'linkSession' | 'readSessionLinks',
): boolean {
  return targetedContributions !== undefined && selectTargetedContributionOperation(targetedContributions, {
    ...triageSourceSelectorV1(source), role,
  }) !== undefined;
}

export function hasTriageSourceSessionRelationsV1(targetedContributions: SurfaceContext['targetedContributions']): boolean {
  return targetedContributions?.points.some((point) => point.protocols.some((protocol) => protocol.contributions.some((contribution) =>
    resolveTriageSourceSessionRelationsV1(targetedContributions, {
      pluginId: contribution.contributor.pluginId, localId: contribution.contributor.contributionId,
    }, 'readSessionLinks')))) ?? false;
}

/** The exact host-created source handle a selected-PR start must carry. */
export function resolveTriageSourcePrepareReviewWorkspaceOperationV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
) : PluginUiTargetedContributionOperationV1 | undefined {
  if (targetedContributions === undefined) return undefined;
  return selectTargetedContributionOperation(targetedContributions, {
    ...triageSourceSelectorV1(source),
    role: TRIAGE_PREPARE_REVIEW_WORKSPACE_ROLE_V1,
  });
}

/** Optional Tasks roles use the same exact admitted-contribution matcher as detail. */
export function resolveTriageSourceTaskOperationV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  source: TriageEntryRefV1['source'],
  role: 'listCreationPlaces' | 'create' | 'edit' | 'transition' | 'readSessionLinks',
) : PluginUiTargetedContributionOperationV1 | undefined {
  if (targetedContributions === undefined) return undefined;
  return selectTargetedContributionOperation(targetedContributions, { ...triageSourceSelectorV1(source), role });
}

/**
 * The exact workflow subject declared by the currently admitted source for one
 * entry kind. The four-identity contribution match above remains the sole
 * source lookup; this projection only parses that matched contribution's typed
 * descriptor and never guesses from a provider id or kind name.
 */
export function resolveTriageSourceWorkflowSubjectV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  entryRef: TriageEntryRefV1,
): TriageSourceWorkflowSubjectV1 | null {
  return projectTriageSourceWorkflowSubjectV1(resolveTriageSourceDescriptorV1(targetedContributions, entryRef.source), entryRef.kindId);
}

/** The mark the source declares for this kind, if it declares one. */
export function resolveTriageSourceKindGlyphV1(
  targetedContributions: SurfaceContext['targetedContributions'],
  entryRef: TriageEntryRefV1,
): TriageSourceKindGlyphV1 | null {
  return resolveTriageSourceDescriptorV1(targetedContributions, entryRef.source)
    ?.kinds.find(kind => kind.id === entryRef.kindId)?.glyph ?? null;
}

/** The descriptor's subject is shared by portable and mounted consumers. */
export function projectTriageSourceWorkflowSubjectV1(
  descriptor: TriageSourceDescriptorV1 | null | undefined,
  kindId: string,
): TriageSourceWorkflowSubjectV1 | null {
  return descriptor?.kinds.find(kind => kind.id === kindId)?.workflowSubject ?? null;
}

/** The same lookup, read from the mount's own host-stamped surface context. */
export function readTriageSourceDetailContributionV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
): TriageSourceDetailContributionLookupV1 {
  return resolveTriageSourceDetailContributionV1(context.targetedContributions, source);
}

/** The descriptor from this mounted surface's one exact snapshot. */
export function readTriageSourceDescriptorV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
): TriageSourceDescriptorV1 | null {
  return resolveTriageSourceDescriptorV1(context.targetedContributions, source);
}

/** The same capability, read from the mount's own host-stamped surface context. */
export function readTriageSourcePreparesReviewWorkspaceV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
): boolean {
  return resolveTriageSourcePreparesReviewWorkspaceV1(context.targetedContributions, source);
}

/** The same exact optional preparation handle from this mounted surface context. */
export function readTriageSourcePrepareReviewWorkspaceOperationV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
) : PluginUiTargetedContributionOperationV1 | undefined {
  return resolveTriageSourcePrepareReviewWorkspaceOperationV1(context.targetedContributions, source);
}

/** The exact current source reread handle consumed immediately before formal review start. */
export function readTriageSourceGetOperationV1(
  context: SurfaceContext,
  source: TriageEntryRefV1['source'],
) : PluginUiTargetedContributionOperationV1 | undefined {
  if (context.targetedContributions === undefined) return undefined;
  return selectTargetedContributionOperation(context.targetedContributions, {
    ...triageSourceSelectorV1(source),
    role: TRIAGE_GET_SOURCE_ENTRY_ROLE_V1,
  });
}
