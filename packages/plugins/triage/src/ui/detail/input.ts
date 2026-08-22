import {
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
    return Object.freeze({
      kind: 'admitted',
      input: TriageDetailSurfaceInputV1Schema.parse({
        v: 1,
        instance: input.instance,
        observation: input.observation,
        linkedSessions: input.linkedSessions,
      }),
    });
  } catch {
    // A value the published contract cannot carry — an over-bound Session
    // projection, for instance — is refused whole. Truncating it here would
    // silently tell the source that a link does not exist.
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
