import { useCallback, useMemo } from 'react';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type {
  TriageEntryPresentationStateV1,
  TriageEntryRefV1,
  TriageRowFactV1,
  TriageSourceDetailTabV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import type { TriageDetailSourceMountV1 } from './body.js';
import type { TriageFixPullRequestPickV1 } from './fixPullRequests.js';
import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import {
  readTriageSourceDescriptorV1,
  readTriageSourceDetailContributionV1,
  resolveTriageSourceWorkflowSubjectV1,
} from './sourceSurface.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';
import {
  useTriageFixPullRequests,
  type TriageFixPullRequestsStateV1,
} from './useTriageFixPullRequests.js';

/**
 * The selected issue or error group's linked fix PR, joined to what the detail
 * needs to render its Files and Checks through that PR's own source (r0.42).
 *
 * The link itself is owned by `useTriageFixPullRequests` (U-TRIAGE-FIX-PR-LINK)
 * and this hook only consumes its `primary` answer: it finds that PR in the
 * device projection, reads its strict detail input through the one entry-detail
 * owner, and resolves the PR's admitted detail surface and declared tabs. A PR
 * the projection does not hold yields no mount, but its admitted kind's declared
 * tabs remain available with the detail frame's canonical unavailable state.
 */
export type TriageDetailFixPullRequestV1 = Readonly<{
  state: TriageFixPullRequestsStateV1 | null;
  mount: TriageDetailSourceMountV1 | null;
  detailTabs: readonly TriageSourceDetailTabV1[] | undefined;
  /** The fix PR's own snapshot facts (its tab summaries), when the projection holds it. */
  facts: readonly TriageRowFactV1[] | undefined;
  /** Pull requests the reader can link, from their own projection. */
  pickable: readonly TriageFixPullRequestPickV1[];
}>;

function findRow(rows: readonly TriageListRowV1[], ref: TriageEntryRefV1): TriageListRowV1 | null {
  return rows.find((candidate) => sameTriageEntryRefV1(candidate.entryRef, ref)) ?? null;
}

export function useTriageDetailFixPullRequest(input: Readonly<{
  context: SurfaceContext;
  row: TriageListRowV1;
  rows: readonly TriageListRowV1[];
  workflowSubject: TriageSourceWorkflowSubjectV1 | null;
  display: Readonly<{ title: string; scopeLabel: string }> | null;
}>): TriageDetailFixPullRequestV1 {
  const { context, row, rows, workflowSubject, display } = input;
  const targeted = context.targetedContributions;
  const workflowSubjectOf = useCallback(
    (ref: TriageEntryRefV1) => resolveTriageSourceWorkflowSubjectV1(targeted, ref),
    [targeted],
  );
  const presentationOf = useCallback((ref: TriageEntryRefV1): TriageEntryPresentationStateV1 | null => {
    const found = findRow(rows, ref);
    const selected = found === null ? null : readTriageSelectedObservationV1(found);
    return selected?.observation.snapshot.state.presentation ?? null;
  }, [rows]);
  const hasFix = workflowSubject === 'issue' || workflowSubject === 'errorIssue';
  const fixInput = useMemo(() => (
    hasFix && display !== null
      ? { entryRef: row.entryRef, display, workflowSubjectOf, presentationOf }
      : null
  ), [display, hasFix, presentationOf, row.entryRef, workflowSubjectOf]);
  const state = useTriageFixPullRequests(fixInput);

  const primary = state?.kind === 'ready' ? state.primary : null;
  const primaryRow = primary === null ? null : findRow(rows, primary.entryRef);
  const selected = useMemo(
    () => (primaryRow === null ? null : readTriageSelectedObservationV1(primaryRow)),
    [primaryRow],
  );
  const detailSource = useMemo(() => (
    primaryRow === null || selected === null
      ? null
      : {
          selection: { entryRef: primaryRow.entryRef, sourceInstanceId: selected.sourceInstanceId },
          observation: selected.observation,
        }
  ), [primaryRow, selected]);
  const detail = useTriageEntryDetail(detailSource);
  const lookup = primary === null ? null : readTriageSourceDetailContributionV1(context, primary.entryRef.source);
  const surface = lookup?.kind === 'admitted' ? lookup.surface : null;
  const detailTabs = primary === null
    ? undefined
    : readTriageSourceDescriptorV1(context, primary.entryRef.source)
      ?.kinds.find((kind) => kind.id === primary.entryRef.kindId)?.detailTabs;

  const mount = useMemo<TriageDetailSourceMountV1 | null>(() => (
    detail?.kind === 'ready' && surface !== null
      ? {
          surface,
          input: detail.input,
          instanceKey: deriveTriageDetailMountInstanceKey(
            detail.input.observation.entryRef,
            detail.input.instance.instance.sourceInstanceId,
          ),
        }
      : null
  ), [detail, surface]);

  const pickable = useMemo<readonly TriageFixPullRequestPickV1[]>(() => (
    hasFix
      ? rows.flatMap((candidate) => {
          if (workflowSubjectOf(candidate.entryRef) !== 'pullRequest') return [];
          const observed = readTriageSelectedObservationV1(candidate);
          if (observed === null) return [];
          return [{
            entryRef: candidate.entryRef,
            title: observed.observation.snapshot.title,
            scopeLabel: observed.observation.snapshot.scopeLabel,
          }];
        })
      : []
  ), [hasFix, rows, workflowSubjectOf]);

  const facts = selected?.observation.snapshot.facts;
  return useMemo(() => ({ state, mount, detailTabs, facts, pickable }), [detailTabs, facts, mount, pickable, state]);
}
