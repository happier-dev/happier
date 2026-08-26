import * as React from 'react';

import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Label,
  Link,
  LoadingState,
  Metadata,
  Row,
  Stack,
  Status,
  TargetedSurface,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
  type ComposerRefV1,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';
import {
  TriageEvidenceDisclosureProvider,
  TriagePostMutationCompletionProvider,
} from '@happier-dev/triage-sources/ui';

import {
  type TriageListLaneV1,
  type TriageListRowV1,
} from '../../projection/listWindow.js';
import { buildTriageEntryAttachmentPresentation } from '../../composer/mutationPlan.js';
import { useTriageTierBEvidenceInsertion } from '../../composer/tierBEvidenceInsertion.js';
import type { TriageMountedActionsV1 } from '../actions/useTriageActions.js';
import {
  readTriagePinActionLabelV1,
  type TriageRowPinHandlersV1,
} from '../list/rows.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import {
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from '../header/entryActionControls.js';
import { describeTriageEntrySessionPhaseV1 } from '../header/sessionStartOutcome.js';
import { useTriageEntrySessionStart } from '../header/useEntrySessionStart.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { projectTriageDetailHeaderV1, type TriageDetailHeaderV1 } from './header.js';
import {
  readTriageSourceDetailContributionV1,
  readTriageSourcePreparesReviewWorkspaceV1,
} from './sourceSurface.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';
import { reobserveTriagePostMutationRow } from './postMutationReobservation.js';
import { TriageLinkedSessions } from './linkedSessions.js';

/**
 * The mounted detail region: the aggregate's common header, and beneath it the
 * source's own detail body.
 *
 * This is the piece that turned a list into a product. Every part of it already
 * existed — the selection reducer, the strict input builder, the six packaged
 * source detail renderers — and nothing mounted them, so a reader could see
 * rows and open none of them.
 *
 * The split is exactly `core/SURFACE.md` §2.2's. The header owns title, source
 * and kind, scope, state, the observing connection, attention and the bounded
 * Session relationship; the source body owns provider-native facts and its own
 * tabs. Neither renders the other's, and this file mounts the source through the
 * shared `TargetedSurface` — it holds no renderer, artifact, catalog or mount
 * lifecycle of its own, because the physical host owns all four.
 *
 * `core/SURFACE.md` §2.3 governs what a refusal is allowed to say: a renderer
 * the host could not mount is named as an unavailable renderer beside the facts
 * the aggregate already holds. It is never reported as a source read failure, a
 * loading state or an empty detail.
 */

export type TriageDetailRegionProps = Readonly<{
  row: TriageListRowV1;
  lanes: readonly TriageListLaneV1[];
  /** The configured connection's display label, when the aggregate knows one. */
  connectionLabel: string | null;
  /**
   * The one aggregate action target, resolved by the shell.
   *
   * It arrives as a prop rather than being derived from `row` because the ONE
   * target reader reads the reducer's `selection` (`ui/state/actionTarget.ts`),
   * and only the shell holds it: a row carries no `sectionId`, and rebuilding a
   * target from the row here would be a second target reader that could act on a
   * different entry than the surface's published context claims.
   */
  target: TriageActionTargetV1;
  /**
   * The CONFIGURED action catalog, read once by the shell.
   *
   * It arrives as a prop for the same reason `target` does: one mount, one
   * read. A hook here would give the detail region its own copy of durable
   * Account configuration, so the editor and the pressed controls could show
   * different sets of the same actions between two settled writes.
   */
  actions: TriageMountedActionsV1;
  /**
   * The Composer this detail was opened FROM, or `null` for an app-origin open.
   *
   * It is the exact address the shell retained from its own closed launch input
   * and never a lookup: `core/COMPOSER.md` §2.1 makes the originating draft a
   * fact of the open, not of whichever Composer happens to be mounted. It stops
   * here — the mounted source is handed a disclosure callback, never this value
   * — because a source that held the address would become a second Composer
   * writer with its own read, token and revision rules.
   */
  originComposer: ComposerRefV1 | null;
  /** The already-projected row and the sole mounted mark handlers. */
  pin: TriageDetailPinActionV1;
  /** Clears the selection; the stacked composition returns to the list. */
  onClose: () => void;
}>;

function headerEntries(
  header: TriageDetailHeaderV1,
  text: (key: string, fallback?: string) => string,
): readonly MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  // §2.2's Source and Type, in the source's own words. Absent rather than
  // guessed: a source with no currently admitted contribution loses the rows.
  if (header.sourceLabel !== null) {
    entries.push({ label: text('plugins.triage.surface.detail.source', 'Source'), value: header.sourceLabel });
  }
  if (header.kindLabel !== null) {
    entries.push({ label: text('plugins.triage.surface.detail.type', 'Type'), value: header.kindLabel });
  }
  if (header.scopeLabel !== null) entries.push({ label: text('plugins.triage.surface.detail.scope', 'Scope'), value: header.scopeLabel });
  if (header.stateLabel !== null) entries.push({ label: text('plugins.triage.surface.detail.state', 'State'), value: header.stateLabel });
  if (header.connectionLabel !== null) {
    entries.push({ label: text('plugins.triage.surface.detail.connection', 'Connection'), value: header.connectionLabel });
  }
  return entries;
}

const EMPTY_SESSIONS: readonly TriageLinkedSessionProjectionV1[] = Object.freeze([]);

/** The words the aggregate uses for what it currently knows about the entry. */
const PRESENCE_COPY = Object.freeze({
  present: null,
  absent: 'This entry is no longer at the source.',
  unresolved: 'This entry could not be read from the source.',
});

export type TriageDetailHeaderViewProps = Readonly<{
  header: TriageDetailHeaderV1;
  /** Clears the selection; the stacked composition returns to the list. */
  onClose: () => void;
  /**
   * These facts are the last ones the aggregate held for this entry, not
   * current ones.
   *
   * It is set exactly when the window no longer lists the selected entry
   * (`ui/shell/lastKnownRow.ts`). Every fact below is then still the entry's
   * own — which is the whole point, because the alternative was a cause with no
   * subject — but none of it has been re-read, so it is stated as past rather
   * than presented as present. Nothing is invented to fill the gap: the source's
   * own detail is not read at all from a retained row, and the facts an
   * admitted contribution would have named are simply absent.
   */
  lastKnown?: boolean;
  /** Visible direct Pin/Unpin for the selected entry. */
  pin?: TriageDetailPinActionV1;
  linkedSessionsPageState?: 'idle' | 'loading' | 'failed';
  onLoadMoreLinkedSessions?: () => void;
}>;

export type TriageDetailPinActionV1 = Readonly<{
  row: TriageListDisplayRowV1;
  handlers: TriageRowPinHandlersV1;
}>;

/**
 * §2.2's common header, rendered once for both the states it has.
 *
 * The mounted detail and a selection the window has stopped listing show the
 * same facts about the same entry and differ only in whether they are current,
 * so they are one renderer with one marker rather than two blocks that drift.
 */
export function TriageDetailHeaderView(props: TriageDetailHeaderViewProps): React.ReactElement {
  const text = usePluginTranslation();
  const header = props.header;
  const entries = headerEntries(header, text);
  const presenceCopy = header.presence === 'present'
    ? null
    : header.presence === 'absent'
      ? text('plugins.triage.surface.detail.entryAbsent', PRESENCE_COPY.absent ?? '')
      : text('plugins.triage.surface.detail.entryUnresolved', PRESENCE_COPY.unresolved ?? '');
  const pinLabel = props.pin === undefined
    ? null
    : readTriagePinActionLabelV1(props.pin.row, text);
  const pinBusy = props.pin !== undefined && props.pin.handlers.busyKey === props.pin.row.key;
  const onSetPinned = React.useCallback(() => {
    if (props.pin !== undefined) props.pin.handlers.onSetPinned(props.pin.row);
  }, [props.pin]);

  return (
    <>
      <Row justify="space-between" align="center">
        <Heading level={2} value={header.title} />
        <Row gap="small" align="center">
          {props.pin === undefined || pinLabel === null ? null : (
            <Button
              title={pinLabel}
              variant="secondary"
              busy={pinBusy}
              disabled={props.pin.handlers.unavailableReason !== null}
              onPress={onSetPinned}
            />
          )}
          <Button titleKey="plugins.triage.surface.close" title="Close" variant="secondary" onPress={props.onClose} />
        </Row>
      </Row>

      {props.lastKnown === true ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.detail.lastKnown"
          label="These are the last facts this page held for this entry, and they may be out of date."
        />
      ) : null}

      {header.attention === null ? null : (
        <Badge
          tone={header.attention.level === 'required' ? 'warning' : 'info'}
          value={header.attention.reasonLabel}
        />
      )}

      {entries.length === 0 ? null : <Metadata entries={entries} />}

      {presenceCopy === null ? null : <Status tone="warning" label={presenceCopy} />}

      {header.sourceReadFailed ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.detail.connectionUnhealthy"
          label="This connection could not be read in the last pass."
        />
      ) : null}

      {header.webUrl === null ? null : (
        <Link
          titleKey="plugins.triage.surface.detail.openAtSource"
          title="Open at the source"
          url={header.webUrl}
        />
      )}

      <TriageLinkedSessions
        sessions={header.linkedSessions}
        hasMore={header.linkedSessionsHasMore}
        pageState={props.linkedSessionsPageState}
        onLoadMore={props.onLoadMoreLinkedSessions}
      />
    </>
  );
}

export function TriageDetailRegion(props: TriageDetailRegionProps): React.ReactElement {
  const context = useSurfaceContext();
  const hostApi = usePluginHostApi();
  const text = usePluginTranslation();
  // The ONE Triage consumer of a source disclosure, mounted for exactly as long
  // as this detail is: it binds the retained origin address and owns the single
  // revision-checked transaction the disclosed candidate becomes.
  const evidenceDisclosure = useTriageTierBEvidenceInsertion(props.originComposer);
  const [postMutationRow, setPostMutationRow] = React.useState<TriageListRowV1 | null>(null);
  React.useEffect(() => { setPostMutationRow(null); }, [props.row]);
  const row = postMutationRow ?? props.row;
  const lookup = readTriageSourceDetailContributionV1(context, row.entryRef.source);

  // Which connection this row is showing, and the observation made through it,
  // read from the ONE owner both this region and a bulk selection's per-entry
  // payload consult (`ui/window/selectedObservation.ts`). A second reader here
  // is how a detail opens — or a bulk action attaches — an entry under a
  // connection the row is not showing.
  const selected = React.useMemo(
    () => readTriageSelectedObservationV1(row),
    [row],
  );
  const selection = React.useMemo(() => (
    selected === null
      ? null
      : { entryRef: row.entryRef, sourceInstanceId: selected.sourceInstanceId }
  ), [row.entryRef, selected]);
  const observation = selected?.observation ?? null;

  const detail = useTriageEntryDetail(
    selection === null || observation === null ? null : { selection, observation },
  );
  const linkedSessions = detail?.kind === 'ready' ? detail.linkedSessions : EMPTY_SESSIONS;
  const linkedSessionsHasMore = detail?.kind === 'ready'
    ? detail.linkedSessionsNextCursor !== undefined
    : false;
  const sourceDescriptor = detail?.kind === 'ready' ? detail.sourceDescriptor : null;
  const header = React.useMemo(() => projectTriageDetailHeaderV1({
    row,
    lanes: props.lanes,
    connectionLabel: props.connectionLabel,
    sourceDescriptor,
    linkedSessions,
    linkedSessionsHasMore,
  }), [linkedSessions, linkedSessionsHasMore, props.connectionLabel, props.lanes, row, sourceDescriptor]);

  const completePostMutation = React.useCallback(async (): Promise<void> => {
    if (selected === null) return;
    const next = await reobserveTriagePostMutationRow(
      hostApi,
      row,
      props.lanes,
      selected.sourceInstanceId,
    );
    if (next !== null) setPostMutationRow(next);
  }, [hostApi, props.lanes, row, selected]);

  /**
   * The header's action controls, and the one press path they lead to.
   *
   * This mount is the point of the whole unit: the controls, the start
   * controller and the orchestrator behind them all existed and nothing rendered
   * them, so the product's headline feature had never been pressable. It lives
   * here because this is the one component that holds both halves — the shell
   * supplies the selection-derived target, and only this component has read the
   * source's declared descriptor and its admitted operation roles.
   *
   * The section is deliberately absent until the entry's workflow subject and a
   * present observation are both known. Offering actions before the descriptor
   * answers would flash a control set chosen for the wrong subject, and a start
   * needs the display facts the link freezes from that observation.
   */
  const controller = useTriageEntrySessionStart();
  const preparesReviewWorkspace = readTriageSourcePreparesReviewWorkspaceV1(
    context,
    row.entryRef.source,
  );
  const display = React.useMemo(() => (
    observation === null
      ? null
      : { locator: observation.locator, scopeLabel: observation.snapshot.scopeLabel }
  ), [observation]);
  const workflowSubject = header.workflowSubject;
  const repository = selected?.repository;
  const snapshot = observation?.snapshot;
  const locator = observation?.locator;
  const onAction = React.useCallback((request: TriageEntryActionRequestV1) => {
    // The pressed action travels WHOLE: its mode, its profile, its prompt, its
    // delivery and its arm are all read by the one controller below. This is
    // the last place a press could have re-decided any of them, and it does
    // not — it only adds the facts this screen holds and the record cannot.
    if (display === null || snapshot === undefined) return;
    controller.start({
      action: request.action,
      entryRef: request.entryRef,
      display,
      // The entry attachment's two halves. Identity is the connection this
      // entry was read through; the presentation is the bounded immutable
      // fallback the host freezes, built by the one composer-side owner so an
      // entry a delivery attaches and an entry the picker attaches are the
      // same record.
      sourceInstance: { source: request.entryRef.source, sourceInstanceId: request.sourceInstanceId },
      presentation: buildTriageEntryAttachmentPresentation({
        title: snapshot.title,
        scopeLabel: snapshot.scopeLabel,
      }),
      ...(locator === undefined ? {} : { lastKnownLocator: locator }),
      // The entry's own forge repository, exactly as its source declared it.
      // It travels from the observation the reader is looking at, so launch
      // placement joins on the same answer the screen is showing rather than
      // re-reading the entry.
      ...(repository === undefined ? {} : { repository }),
    });
  }, [controller, display, locator, repository, snapshot]);
  const notice = describeTriageEntrySessionPhaseV1(controller.phase);

  return (
    <Stack gap="small">
      <TriageDetailHeaderView
        header={header}
        pin={props.pin}
        onClose={props.onClose}
        {...(detail?.kind === 'ready' ? {
          linkedSessionsPageState: detail.linkedSessionsPageState,
          onLoadMoreLinkedSessions: detail.loadMoreLinkedSessions,
        } : {})}
      />

      {workflowSubject === null || display === null ? null : (
        <Stack gap="small">
          <TriageEntryActionControls
            target={props.target}
            actions={props.actions.actions}
            workflowSubject={workflowSubject}
            preparesReviewWorkspace={preparesReviewWorkspace}
            onAction={onAction}
          />
          {notice === null ? null : (
            <Status tone={notice.tone} labelKey={notice.labelKey} label={notice.label} />
          )}
        </Stack>
      )}

      {detail === null ? (
        <EmptyState
          titleKey="plugins.triage.surface.detail.noConnection.title"
          title="No connection to open this through"
          descriptionKey="plugins.triage.surface.detail.noConnection.description"
          description="No configured connection currently observes this entry, so there is nothing to read it with."
        />
      ) : detail.kind === 'reading' ? (
        <LoadingState titleKey="plugins.triage.surface.detail.reading" title="Reading this entry" />
      ) : detail.kind === 'unavailable' ? (
        <EmptyState
          titleKey="plugins.triage.surface.detail.removedConnection.title"
          title="This connection is no longer configured"
          descriptionKey="plugins.triage.surface.detail.removedConnection.description"
          description="The connection this entry was read through has been removed or replaced, so its details cannot be opened."
        />
      ) : detail.kind === 'unreachable' ? (
        <ErrorState
          titleKey="plugins.triage.surface.detail.accountError.title"
          title="Your account could not be read"
          descriptionKey="plugins.triage.surface.detail.accountError.description"
          description="Happier could not reach your account, so this entry's details are unavailable right now."
        />
      ) : detail.kind === 'refused' ? (
        <Banner
          tone="warning"
          title={text('plugins.triage.surface.detail.prepareError.title', 'These details could not be prepared')}
          description={text('plugins.triage.surface.detail.prepareError.description', 'What Happier holds for this entry does not fit what a source detail is allowed to receive, so it was not handed over.')}
        />
      ) : lookup.kind !== 'admitted' ? (
        <EmptyState
          titleKey="plugins.triage.surface.detail.noDetail.title"
          title="This source has no detail view"
          descriptionKey="plugins.triage.surface.detail.noDetail.description"
          description="The source that owns this entry does not currently contribute a detail surface."
        />
      ) : (
        <TriagePostMutationCompletionProvider onComplete={completePostMutation}>
          <TriageEvidenceDisclosureProvider disclosure={evidenceDisclosure}>
            <TargetedSurface
              surface={lookup.surface}
              input={detail.input}
            // Remounts on entry and on connection, and on nothing else: a refresh
            // that re-reads the same selection must not throw away the tab, scroll
            // and parser state the source body is holding.
            //
            // The entry half is the CANONICAL reference, through the one encoder
            // the fold and the pinned-row join already share. `entryId` alone is
            // not the entry: GitLab issue #5 and merge request !5 in one project
            // differ only by `kindId`, and two sources can answer for the same
            // number in different scopes. A key that named only the number folded
            // those into one mount identity, and spelling the join here a second
            // time would be a second encoder for one key.
              instanceKey={deriveTriageDetailMountInstanceKey(row.entryRef, detail.input.instance.instance.sourceInstanceId)}
              fallback={(
                <EmptyState
                // §2.3: the host's mount lifecycle is not source-domain status.
                titleKey="plugins.triage.surface.detail.mountError.title"
                title="This source's detail view is unavailable"
                descriptionKey="plugins.triage.surface.detail.mountError.description"
                description="Happier could not mount the source's own view of this entry. The facts above are what the aggregate already knows."
                />
              )}
            />
          </TriageEvidenceDisclosureProvider>
        </TriagePostMutationCompletionProvider>
      )}
    </Stack>
  );
}
