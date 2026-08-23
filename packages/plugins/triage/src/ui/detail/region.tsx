import * as React from 'react';

import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Item,
  ItemGroup,
  Label,
  Link,
  LoadingState,
  Metadata,
  Row,
  Stack,
  Status,
  TargetedSurface,
  usePluginTranslation,
  useSurfaceContext,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import {
  type TriageListLaneV1,
  type TriageListRowV1,
} from '../../projection/listWindow.js';
import { TRIAGE_DEFAULT_ENTRY_ACTIONS_V1 } from '../../settings/entryActions.js';
import {
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from '../header/entryActionControls.js';
import { describeTriageEntrySessionPhaseV1 } from '../header/sessionStartOutcome.js';
import { useTriageEntrySessionStart } from '../header/useEntrySessionStart.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import { projectTriageDetailHeaderV1, type TriageDetailHeaderV1 } from './header.js';
import {
  readTriageSourceDetailContributionV1,
  readTriageSourcePreparesReviewWorkspaceV1,
} from './sourceSurface.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';

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

function LinkedSessions(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (props.sessions.length === 0) return null;
  return (
    <Stack gap="small">
      <Label value={text('plugins.triage.surface.detail.sessions', 'Sessions')} />
      <ItemGroup accessibilityLabel={text('plugins.triage.surface.detail.sessions', 'Sessions')}>
        {props.sessions.map((session) => (
          <Item
            key={session.sessionId}
            // A retained link whose Session the host cannot answer for keeps
            // its row: dropping it would say the entry was never worked on.
            title={session.displayTitle ?? text('plugins.triage.surface.detail.session', 'Session')}
            accessibilityLabel={session.displayTitle ?? text('plugins.triage.surface.detail.session', 'Session')}
          />
        ))}
      </ItemGroup>
    </Stack>
  );
}

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

  return (
    <>
      <Row justify="space-between" align="center">
        <Heading level={2} value={header.title} />
        <Button titleKey="plugins.triage.surface.close" title="Close" variant="secondary" onPress={props.onClose} />
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

      <LinkedSessions sessions={header.linkedSessions} />
    </>
  );
}

export function TriageDetailRegion(props: TriageDetailRegionProps): React.ReactElement {
  const context = useSurfaceContext();
  const text = usePluginTranslation();
  const lookup = readTriageSourceDetailContributionV1(context, props.row.entryRef.source);

  const selection = React.useMemo(() => (
    props.row.selected.kind === 'selected'
      ? { entryRef: props.row.entryRef, sourceInstanceId: props.row.selected.sourceInstanceId }
      : null
  ), [props.row]);
  const observation = React.useMemo(() => {
    if (selection === null) return null;
    const found = props.row.observations.find(
      (candidate) => candidate.sourceInstanceId === selection.sourceInstanceId
        && candidate.outcome.kind === 'present',
    );
    if (found === undefined || found.outcome.kind !== 'present') return null;
    return {
      entryRef: props.row.entryRef,
      observedAtMs: found.observedAtMs,
      locator: found.outcome.locator,
      snapshot: found.outcome.snapshot,
      viewer: found.outcome.viewer,
      ...(found.outcome.sourceUpdatedAtMs === undefined
        ? {}
        : { sourceUpdatedAtMs: found.outcome.sourceUpdatedAtMs }),
    };
  }, [props.row, selection]);

  const detail = useTriageEntryDetail(
    selection === null || observation === null ? null : { selection, observation },
  );
  const linkedSessions = detail?.kind === 'ready' ? detail.input.linkedSessions : EMPTY_SESSIONS;
  const sourceDescriptor = detail?.kind === 'ready' ? detail.sourceDescriptor : null;
  const header = React.useMemo(() => projectTriageDetailHeaderV1({
    row: props.row,
    lanes: props.lanes,
    connectionLabel: props.connectionLabel,
    sourceDescriptor,
    linkedSessions,
  }), [linkedSessions, props.connectionLabel, props.lanes, props.row, sourceDescriptor]);

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
    props.row.entryRef.source,
  );
  const display = React.useMemo(() => (
    observation === null
      ? null
      : { locator: observation.locator, scopeLabel: observation.snapshot.scopeLabel }
  ), [observation]);
  const workflowSubject = header.workflowSubject;
  const onAction = React.useCallback((request: TriageEntryActionRequestV1) => {
    // The declared mode travels unchanged: this is the last place a press could
    // have re-decided what it asked for, and it does not.
    if (display === null) return;
    controller.start({
      workspaceMode: request.action.workspaceMode,
      entryRef: request.entryRef,
      display,
    });
  }, [controller, display]);
  const notice = describeTriageEntrySessionPhaseV1(controller.phase);

  return (
    <Stack gap="small">
      <TriageDetailHeaderView header={header} onClose={props.onClose} />

      {workflowSubject === null || display === null ? null : (
        <Stack gap="small">
          <TriageEntryActionControls
            target={props.target}
            actions={TRIAGE_DEFAULT_ENTRY_ACTIONS_V1}
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
          instanceKey={deriveTriageDetailMountInstanceKey(props.row.entryRef, detail.input.instance.instance.sourceInstanceId)}
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
      )}
    </Stack>
  );
}
