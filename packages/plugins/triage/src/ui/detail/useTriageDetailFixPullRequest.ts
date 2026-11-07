import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import { usePluginHostApi, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { TriageDetailFixPullRequestNavigationV1 } from '@happier-dev/triage-sources/ui';
import type {
  TriageEntryRefV1,
  TriageRowFactV1,
  TriageSourceDetailTabV1,
  TriageSourceWorkflowSubjectV1,
  TriageFixPullRequestV1,
  TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { TriagePullRequestStatusResultV1Schema } from '@happier-dev/triage-protocol/v1';

import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';
import { readTriageSelectedObservationV1, type TriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { TriageReobserveEntryResultV1Schema, TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from '../../actions/reobserveEntryProtocol.js';
import { TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1 } from '../../actions/entryDetailProtocol.js';
import type { TriageDetailSourceMountV1 } from './body.js';
import type { TriageFixPullRequestPickV1 } from './fixPullRequests.js';
import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import {
  readTriageSourceDescriptorV1,
  readTriageSourceDetailContributionV1,
  resolveTriageSourceWorkflowSubjectV1,
} from './sourceSurface.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';
import { openTriageEntryDetails } from '../../composer/openEntryDetails.js';
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
 * device projection or reads an off-page native association exactly, then reads
 * its strict detail input through the one entry-detail owner and resolves the
 * PR's admitted detail surface and declared tabs.
 */
export type TriageDetailFixPullRequestV1 = Readonly<{
  state: TriageFixPullRequestsStateV1 | null;
  mount: TriageDetailSourceMountV1 | null;
  detailTabs: readonly TriageSourceDetailTabV1[] | undefined;
  /** The fix PR's own facts, including its source-owned status summary for an off-page association. */
  facts: readonly TriageRowFactV1[] | undefined;
  /** Pull requests the reader can link, from their own projection. */
  pickable: readonly TriageFixPullRequestPickV1[];
  navigation: TriageDetailFixPullRequestNavigationV1 | null;
}>;

function findRow(rows: readonly TriageListRowV1[], ref: TriageEntryRefV1): TriageListRowV1 | null {
  return rows.find((candidate) => sameTriageEntryRefV1(candidate.entryRef, ref)) ?? null;
}

/** Off-page associations use the same exact-read Action as ordinary entry refresh. */
export async function readTriageExactFixPullRequest(
  host: Readonly<{ executeAction(action: string, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown> }>,
  candidate: TriageFixPullRequestV1,
  options?: PluginCancellationOptions,
): Promise<TriageSelectedObservationV1 | null> {
  if (candidate.sourceContext === undefined) return null;
  const result = TriageReobserveEntryResultV1Schema.parse(await host.executeAction(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
    { v: 1, entryRef: candidate.entryRef, ...candidate.sourceContext }, options));
  if (result.kind !== 'observed' || !sameTriageEntryRefV1(result.entryRef, candidate.entryRef)
    || result.observation.sourceInstanceId !== candidate.sourceContext.sourceInstanceId || result.observation.outcome.kind !== 'present') return null;
  const { outcome, observedAtMs, sourceInstanceId } = result.observation;
  return { sourceInstanceId,
    ...(candidate.sourceContext.sourceInstanceRowId === undefined ? {} : { sourceInstanceRowId: candidate.sourceContext.sourceInstanceRowId }),
    observation: { entryRef: result.entryRef, observedAtMs,
    locator: outcome.locator, snapshot: outcome.snapshot, viewer: outcome.viewer,
    ...(outcome.sourceUpdatedAtMs === undefined ? {} : { sourceUpdatedAtMs: outcome.sourceUpdatedAtMs }) } };
}

/** One mounted off-page snapshot and status read, belonging to this Account and exact admitted candidate. */
export function useTriageOffPageFixPullRequest(candidate: TriageFixPullRequestV1 | null): TriageSelectedObservationV1 | null {
  const host = usePluginHostApi();
  const owner = usePluginUiEphemeralSharedScope();
  const [settled, setSettled] = useState<Readonly<{
    owner: typeof owner;
    host: typeof host;
    candidate: TriageFixPullRequestV1;
    selected: TriageSelectedObservationV1 | null;
  }> | null>(null);
  useEffect(() => {
    if (candidate?.sourceContext === undefined) return;
    const controller = new AbortController();
    void readTriageExactFixPullRequest(host, candidate, { signal: controller.signal }).then(async (selected) => {
      if (selected !== null && !controller.signal.aborted) {
        try {
          const status = TriagePullRequestStatusResultV1Schema.parse(await host.executeAction(
            TRIAGE_READ_PULL_REQUEST_STATUS_ACTION_LOCAL_ID_V1,
            { v: 1, entryRef: candidate.entryRef, ...candidate.sourceContext },
            { signal: controller.signal },
          ));
          if (status.kind === 'status') {
            const facts = new Map(selected.observation.snapshot.facts.map((fact) => [fact.id, fact]));
            for (const fact of status.facts) facts.set(fact.id, fact);
            selected = { ...selected, observation: { ...selected.observation,
              snapshot: { ...selected.observation.snapshot, facts: [...facts.values()] } } };
          }
        } catch {
          // An unavailable status summary does not erase the PR's answered snapshot.
        }
      }
      if (!controller.signal.aborted) setSettled({ owner, host, candidate, selected });
    }).catch(() => { if (!controller.signal.aborted) setSettled({ owner, host, candidate, selected: null }); });
    return () => controller.abort();
  }, [candidate, host, owner]);
  // Read ingress retains equal candidate identity; a new reference carries new admitted authority/evidence.
  return settled !== null && settled.owner === owner && settled.host === host && settled.candidate === candidate ? settled.selected : null;
}

export function useTriageFixPullRequestNavigationBinding(
  candidate: TriageFixPullRequestV1 | null,
  selected: TriageSelectedObservationV1 | null,
): TriageDetailFixPullRequestNavigationV1 | null {
  const host = usePluginHostApi();
  const owner = usePluginUiEphemeralSharedScope();
  const matches = candidate !== null && selected !== null && sameTriageEntryRefV1(candidate.entryRef, selected.observation.entryRef)
    && (candidate.sourceContext === undefined || candidate.sourceContext.sourceInstanceId === selected.sourceInstanceId);
  const observation = matches ? selected?.observation : undefined;
  // Native associations already admit their connection; an off-page snapshot supplies content, not navigation authority.
  const sourceInstanceId = candidate?.sourceContext?.sourceInstanceId ?? (matches ? selected?.sourceInstanceId : undefined);
  // Observation refreshes do not retire this admitted entry/connection's navigation.
  const witness = useMemo(() => ({ controller: new AbortController() }), [candidate, host, owner, sourceInstanceId]);
  const current = useRef(witness);
  current.current = witness;
  useLayoutEffect(() => {
    // StrictMode may replay this lifetime; each setup owns its own cancellation signal.
    witness.controller = new AbortController();
    return () => witness.controller.abort();
  }, [witness]);
  return useMemo(() => {
    if (candidate === null || sourceInstanceId === undefined) return null;
    const isCurrent = () => current.current === witness && !witness.controller.signal.aborted;
    const url = observation?.locator.webUrl ?? candidate.sourceContext?.lastKnownLocator.webUrl ?? null;
    return {
      entryRef: candidate.entryRef, title: observation?.snapshot.title ?? candidate.display.title ?? candidate.entryRef.entryId, url,
      open: async (options) => {
        if (!isCurrent()) return { kind: 'cancelled' };
        const merged = mergeAbortSignals([witness.controller.signal, options?.signal]);
        try {
          return await openTriageEntryDetails({ hostApi: host, entryRef: candidate.entryRef,
            sourceInstance: { source: candidate.entryRef.source, sourceInstanceId },
            signal: merged.signal });
        } finally {
          merged.dispose();
        }
      },
      openExternal: async () => { if (isCurrent() && url !== null) await host.openExternalLink(url); },
    } satisfies TriageDetailFixPullRequestNavigationV1;
  }, [candidate, host, observation, sourceInstanceId, witness]);
}

export function useTriageDetailFixPullRequest(input: Readonly<{
  context: SurfaceContext;
  row: TriageListRowV1;
  rows: readonly TriageListRowV1[];
  workflowSubject: TriageSourceWorkflowSubjectV1 | null;
  display: Readonly<{ title: string; scopeLabel: string }> | null;
  instance?: TriageConfiguredSourceInstanceV1;
  refreshGeneration?: number;
}>): TriageDetailFixPullRequestV1 {
  const { context, row, rows, workflowSubject, display, instance } = input;
  const targeted = context.targetedContributions;
  const workflowSubjectOf = useCallback(
    (ref: TriageEntryRefV1) => resolveTriageSourceWorkflowSubjectV1(targeted, ref),
    [targeted],
  );
  const hasFix = workflowSubject === 'issue' || workflowSubject === 'errorIssue';
  const finding = useMemo(() => readTriageSelectedObservationV1(row), [row]);
  const lastKnownLocator = finding?.observation.locator;
  // The fold retains unchanged locator facts. New title/state facts do not
  // retire a pending relationship read through this same selected connection.
  const sourceContext = useMemo(() => instance === undefined || lastKnownLocator === undefined ? undefined : {
    instance, lastKnownLocator,
  }, [instance, lastKnownLocator]);
  const fixInput = useMemo(() => (
    hasFix && display !== null && sourceContext !== undefined
      ? { entryRef: row.entryRef, display, sourceContext }
      : null
  ), [display, hasFix, row.entryRef, sourceContext]);
  const state = useTriageFixPullRequests(fixInput, input.refreshGeneration);

  const primary = state?.kind === 'ready' ? state.primary : null;
  const primaryRow = primary === null ? null : findRow(rows, primary.entryRef);
  const offPage = useTriageOffPageFixPullRequest(primaryRow === null ? primary : null);
  const selected = useMemo(
    () => primaryRow !== null ? readTriageSelectedObservationV1(primaryRow)
      : offPage,
    [offPage, primaryRow],
  );
  const detailSource = useMemo(() => (
    primary === null || selected === null
      ? null
      : {
          selection: { entryRef: primary.entryRef, sourceInstanceId: selected.sourceInstanceId,
            ...(selected.sourceInstanceRowId === undefined ? {} : { sourceInstanceRowId: selected.sourceInstanceRowId }) },
          observation: selected.observation,
        }
  ), [primary, selected]);
  const detail = useTriageEntryDetail(detailSource);
  const lookup = primary === null ? null : readTriageSourceDetailContributionV1(context, primary.entryRef.source);
  const surface = lookup?.kind === 'admitted' ? lookup.surface : null;
  const navigation = useTriageFixPullRequestNavigationBinding(primary, selected);
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
  return useMemo(() => ({ state, mount, detailTabs, facts, pickable, navigation }), [detailTabs, facts, mount, navigation, pickable, state]);
}
