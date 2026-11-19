import {
  MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
  TriageLinkedSessionProjectionV1Schema,
  TriageDetailSurfaceInputV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import { sameTriageEntryRefV1, type TriageSurfaceSelectionV1 } from '../state/surface.js';

/**
 * The strict detail boundary (`core/SURFACE.md` §2.2, `CONTRACT.md` §7).
 *
 * A mounted source detail receives ONLY the exact entry ref, the exact selected
 * configured instance and the bounded linked-Session projection. It receives no
 * aggregate freshness field, refresh-state marker, credential, DTO, registry,
 * callback, renderer id or aggregate state object — which is why the value is
 * built and then admitted by the published closed schema rather than assembled
 * ad hoc at a call site.
 *
 * This is also where the surface stops carrying `TriageSurfaceSelectionV1`'s
 * stable UUID and starts carrying the exact current `TriageSourceInstanceRefV1`
 * that Corpus materialized: the surface never reconstructs that ref itself.
 */
export type TriageDetailSurfaceInputBuildV1 =
  | Readonly<{ kind: 'admitted'; input: TriageDetailSurfaceInputV1 }>
  | Readonly<{
      kind: 'refused';
      reason: 'entryMismatch' | 'instanceMismatch' | 'invalidContractValue';
    }>;

export type TriageDetailSurfaceInputBuildInputV1 = Readonly<{
  /**
   * The two selection facts the boundary actually compares. The section id is
   * presentation and takes no part in it, so it is deliberately not required —
   * a caller that had to invent one would be supplying a value this owner
   * ignores.
   */
  selection: Pick<TriageSurfaceSelectionV1, 'entryRef' | 'sourceInstanceId'>;
  /** The exact configured instance Corpus materialized for this selection. */
  instance: TriageConfiguredSourceInstanceV1;
  /** The host-applied present observation for the selected entry. */
  observation: TriageDetailSurfaceInputV1['observation'];
  /** `[]` means no links; it is never an "unknown" placeholder. */
  linkedSessions: TriageDetailSurfaceInputV1['linkedSessions'];
  /** Whether another page exists; absence is complete, as in the published detail input. */
  linkedSessionsHasMore?: boolean;
  /** The entry's latest admitted PR Review and round, recorded by Triage; absent when none. */
  admittedReview?: TriageDetailSurfaceInputV1['admittedReview'];
  /** Transient source-owned facts from this exact opening read. */
  detailData?: TriageDetailSurfaceInputV1['detailData'];
  /** The panel rendered by this physical mount. */
  panel?: string;
  panelScrollOwner?: TriageDetailSurfaceInputV1['panelScrollOwner'];
}>;

export function buildTriageDetailSurfaceInputV1(
  input: TriageDetailSurfaceInputBuildInputV1,
): TriageDetailSurfaceInputBuildV1 {
  if (!sameTriageEntryRefV1(input.observation.entryRef, input.selection.entryRef)) {
    return REFUSED_ENTRY_MISMATCH;
  }

  const instanceRef = input.instance.instance;
  const instanceAgrees = instanceRef.sourceInstanceId === input.selection.sourceInstanceId
    && sameTriageSourceIdentity(instanceRef.source, input.selection.entryRef.source);
  if (!instanceAgrees) return REFUSED_INSTANCE_MISMATCH;

  try {
    // Reject malformed trusted values before projecting presentation, so fitting
    // cannot hide a bad identity, unknown authority field or invalid source data.
    const sessions = input.linkedSessions.map((session) => TriageLinkedSessionProjectionV1Schema.parse(session));
    const parsed = TriageDetailSurfaceInputV1Schema.parse({
      v: 1,
      instance: input.instance,
      observation: input.observation,
      ...(input.detailData === undefined ? {} : { detailData: input.detailData }),
      ...(input.admittedReview === undefined ? {} : { admittedReview: input.admittedReview }),
      linkedSessions: sessions.slice(0, MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1),
      linkedSessionsHasMore: input.linkedSessionsHasMore || sessions.length > MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
      ...(input.panel === undefined ? {} : { panel: input.panel }),
      ...(input.panelScrollOwner === undefined ? {} : { panelScrollOwner: input.panelScrollOwner }),
    });
    return Object.freeze({
      kind: 'admitted',
      // Parsing the presentation must not replace the unchanged connection:
      // its identity owns pending native relationship reads across refreshes.
      input: { ...parsed, instance: input.instance,
        // This validated exact-read value belongs to the open, not to Session
        // paging or retained-row publications rebuilding the detail envelope.
        ...(input.detailData === undefined ? {} : { detailData: input.detailData }) },
    });
  } catch {
    // Invalid trusted values are still refused whole. Valid presentation may
    // be shortened only with the contract's explicit incompleteness markers.
    return REFUSED_INVALID_CONTRACT_VALUE;
  }
}

const REFUSED_ENTRY_MISMATCH: TriageDetailSurfaceInputBuildV1 = Object.freeze({
  kind: 'refused',
  reason: 'entryMismatch',
});
const REFUSED_INSTANCE_MISMATCH: TriageDetailSurfaceInputBuildV1 = Object.freeze({
  kind: 'refused',
  reason: 'instanceMismatch',
});
const REFUSED_INVALID_CONTRACT_VALUE: TriageDetailSurfaceInputBuildV1 = Object.freeze({
  kind: 'refused',
  reason: 'invalidContractValue',
});
