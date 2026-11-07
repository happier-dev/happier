import {
    triagePagedPanelReducer, type TriagePagedPanelEventV1, type TriagePagedPanelStateV1, type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import type { ForgeReleaseV1 } from '@happier-dev/triage-protocol/releases/v1';
import { reconcileReleaseRowsV1 } from '../../releases/mapping.js';

type Incomplete = 'pagination' | 'provider_ceiling';
export type ReleaseListStateV1 = TriagePagedPanelStateV1<ForgeReleaseV1, TriageSourceFailureV1, Incomplete>;

/** The shared pager owns warm/error/paging semantics; Releases supplies only keyed row construction. */
export function reduceReleaseListV1(state: ReleaseListStateV1,
    event: TriagePagedPanelEventV1<ForgeReleaseV1, TriageSourceFailureV1, Incomplete>): ReleaseListStateV1 {
    return triagePagedPanelReducer(state, event, {
        reconcileRows(previous, incoming, { replacing }) {
            return reconcileReleaseRowsV1(previous, replacing ? incoming : [...previous, ...incoming]);
        },
    });
}
