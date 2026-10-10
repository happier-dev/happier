import * as React from 'react';

import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import {
  Badge,
  Banner,
  BrandMark,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Icon,
  IconButton,
  LoadingState,
  Row,
  ScrollArea,
  Stack,
  Status,
  TargetedSurface,
  Text,
  useSessionState,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
  type ComposerRefV1,
} from '@happier-dev/plugin-ui';
import { isHappierIconName } from '@happier-dev/plugin-ui/presentation';
import type {
  TriageDetailSurfaceInputV1,
  TriageLinkedSessionProjectionV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';
import { TriageGetResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiTargetedContributionOperationV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageActionV1 } from '../../settings/actions.js';
import { createReviewCommentLinkedIssueIdV1 } from '@happier-dev/plugin-sdk/reviews';
import {
  TriageEvidenceDisclosureProvider,
  TriagePostMutationCompletionProvider,
  type TriageSourcePanelActionsV1,
} from '@happier-dev/triage-sources/ui';

import {
  type TriageListLaneV1,
  type TriageListRowV1,
} from '../../projection/listWindow.js';
import { buildTriageEntryAttachmentPresentation } from '../../composer/mutationPlan.js';
import { useTriageTierBEvidenceInsertion } from '../../composer/tierBEvidenceInsertion.js';
import type { TriageMountedActionsV1 } from '../actions/useTriageActions.js';
import {
  readTriageAttentionBadgeToneV1,
  readTriagePinActionLabelV1,
  readTriageRowMarkV1,
  type TriageRowPinHandlersV1,
} from '../list/rows.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import {
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from '../header/entryActionControls.js';
import { describeTriageEntrySessionPhaseV1 } from '../header/sessionStartOutcome.js';
import {
  useTriageEntrySessionStart,
  type TriageEntrySessionStartRequestV1,
} from '../header/useEntrySessionStart.js';
import { TriagePullRequestReviewChooser } from '../header/PullRequestReviewChooser.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { projectTriageDetailHeaderV1, readTriageDetailContextLineV1, type TriageDetailHeaderV1 } from './header.js';
import {
  readTriageSourceDetailContributionV1,
  readTriageSourceDescriptorV1,
  readTriageSourcePrepareReviewWorkspaceOperationV1,
  readTriageSourceGetOperationV1,
} from './sourceSurface.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';
import { TriageLinkedSessions } from './linkedSessions.js';
import { TriageDetailWholeBody, TriageSessionPanel } from './sessionPanel.js';
import { TriageDetailPanelMount, TriageDetailTabbedBody, type TriageDetailSourceMountV1, type TriageDetailTabSelectionV1 } from './body.js';
import { TriageAgentStep, TriagePermissionCard } from './storyRail.js';
import { TriageFixPullRequests } from './fixPullRequests.js';
import { useTriageDetailFixPullRequest } from './useTriageDetailFixPullRequest.js';
import { planTriageDetailTabsV1 } from './tabs.js';
import { TRIAGE_DETAIL_ACTIONS_PANEL_V1 } from '@happier-dev/triage-protocol/v1';

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
  sourcePanelActions?: TriageSourcePanelActionsV1;
  tabSelection: TriageDetailTabSelectionV1;
  sessionSelection: Readonly<{
    value: string | null;
    onChange(sessionId: string): void;
    onAvailableSessionsChange(sessions: readonly TriageLinkedSessionProjectionV1[]): void;
  }>;
  headerHosted?: boolean;
  row: TriageListRowV1;
  /** Reobserves the shell-owned selected snapshot used by both identity and body. */
  completePostMutation(): Promise<void>;
  lanes: readonly TriageListLaneV1[];
  /**
   * The device projection's rows: where the linked fix PR's observation is
   * found, and the pull requests a reader can link (r0.42).
   */
  rows: readonly TriageListRowV1[];
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

/**
 * The entry's context as one quiet line: where it lives, where it stands and which connection is reading it —
 * the row's own context, said once under the title rather than again as a label/value form. What the entry IS
 * is its glyph's job (shared with its row), so the kind is not said again in words.
 */
export { readTriageDetailContextLineV1 } from './header.js';

/** The header and the entry actions scroll as one block above the source body, never over it. */
const DETAIL_HEADER_SCROLL_STYLE_V1 = Object.freeze({ flexGrow: 0, flexShrink: 1, maxHeight: '45%' as const });
const DETAIL_FILL_STYLE_V1 = Object.freeze({ flex: 1, minWidth: 0, minHeight: 0 });
const DETAIL_TITLE_STYLE_V1 = Object.freeze({ flex: 1, minWidth: 0 });

const EMPTY_SESSIONS: readonly TriageLinkedSessionProjectionV1[] = Object.freeze([]);

/** The words the aggregate uses for what it currently knows about the entry. */
const PRESENCE_COPY = Object.freeze({
  present: null,
  absent: 'This entry is no longer at the source.',
  unresolved: 'This entry could not be read from the source.',
});

export type TriageDetailHeaderViewProps = Readonly<{
  /** The Collection's host band already renders identity, actions and Close. */
  headerHosted?: boolean;
  header: TriageDetailHeaderV1;
  /** Retires linked-Session press state when the selected entry/connection changes. */
  instanceKey?: string;
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
  /** The entry action row carries the attention reason at its far end, so the header does not repeat it. */
  attentionInActions?: boolean;
  /** Visible direct Pin/Unpin for the selected entry. */
  pin?: TriageDetailPinActionV1;
  linkedSessionsPageState?: 'idle' | 'loading' | 'failed';
  onLoadMoreLinkedSessions?: () => void;
  onSelectLinkedSession?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  /**
   * Whether the header lists the linked Sessions. A tabbed detail shows them
   * as the Overview story's agent step instead, so they appear once.
   */
  showLinkedSessions?: boolean;
}>;

export type TriageDetailPinActionV1 = Readonly<{
  row: TriageListDisplayRowV1;
  handlers: TriageRowPinHandlersV1;
}>;

/**
 * The transient action/review controller for exactly one entry and observing
 * connection.
 *
 * Its caller keys this component with the same canonical entry+instance key as
 * the source body. The common header around it stays mounted as §2.2 requires,
 * while every in-flight/busy/review state from A is retired before B's controls
 * render. Keeping the hooks inside this boundary is load-bearing: a keyed JSX
 * wrapper around hooks owned by the parent would remount no state at all.
 */
function TriageEntryScopedActionRegion(props: Readonly<{
  target: TriageActionTargetV1;
  actions: TriageMountedActionsV1;
  workflowSubject: TriageSourceWorkflowSubjectV1;
  display: TriageEntrySessionStartRequestV1['display'];
  presentation: TriageEntrySessionStartRequestV1['presentation'];
  lastKnownLocator?: NonNullable<TriageEntrySessionStartRequestV1['lastKnownLocator']>;
  repository?: NonNullable<TriageEntrySessionStartRequestV1['repository']>;
  reviewWorkspace?: NonNullable<TriageEntrySessionStartRequestV1['reviewWorkspace']>;
  comparisonRead?: Readonly<{
    operation: PluginUiTargetedContributionOperationV1;
    instance: TriageDetailSurfaceInputV1['instance'];
  }>;
  linkedSessionIds: readonly string[];
  /** Whether the reader opened this entry; it decides which action leads. */
  viewerIsAuthor: boolean;
  /** The source's own write controls, held in the header's More rather than above the tabs (r0.42). */
  sourceActions?: React.ReactNode;
  /** The entry's attention reason, at the far end of the action row. */
  attention?: React.ReactNode;
}>): React.ReactElement {
  const host = usePluginHostApi();
  const controller = useTriageEntrySessionStart();
  const [comparisonFailed, setComparisonFailed] = React.useState(false);
  const [readingComparison, setReadingComparison] = React.useState(false);
  const reading = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const readComparison = React.useCallback(async () => {
    const read = props.comparisonRead;
    if (read === undefined || props.target.kind !== 'entry') return undefined;
    const entry = props.target.entryRef;
    const localRef = { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId };
    const result = TriageGetResultV1Schema.safeParse(await host.executeAction(read.operation.action, {
      v: 1, instance: read.instance, localRef,
      ...(props.lastKnownLocator === undefined ? {} : { lastKnownLocator: props.lastKnownLocator }),
    }));
    if (!result.success || result.data.kind !== 'present'
      || !pluginJsonValuesEqual(result.data.localRef, localRef)) return undefined;
    return result.data.comparisonSource;
  }, [host, props.comparisonRead, props.lastKnownLocator, props.target]);
  const onAction = React.useCallback((request: TriageEntryActionRequestV1) => {
    // The pressed action travels WHOLE: its mode, its profile, its prompt, its
    // delivery and its arm are all read by the one controller below. This is
    // the last place a press could have re-decided any of them, and it does
    // not — it only adds the facts this screen holds and the record cannot.
    return (async () => {
      const executable = await props.actions.resolveForExecution(
        request.action.actionId,
        [props.workflowSubject],
      );
      // Said beside the control that was pressed, never swallowed.
      if (executable.status !== 'resolved') return { kind: executable.status };
      let comparisonSource;
      if (executable.action.target.kind === 'reviewStart') {
        try { comparisonSource = await readComparison(); } catch { /* Findings-only review remains available. */ }
        if (!mounted.current) return null;
      }
      controller.start({
        action: executable.action,
        entryRef: request.entryRef,
        display: props.display,
        // The entry attachment's two halves. Identity is the connection this
        // entry was read through; the presentation is the bounded immutable
        // fallback the host freezes, built by the one composer-side owner so an
        // entry a delivery attaches and an entry the picker attaches are the
        // same record.
        sourceInstance: { source: request.entryRef.source, sourceInstanceId: request.sourceInstanceId },
        presentation: props.presentation,
        ...(props.lastKnownLocator === undefined ? {} : { lastKnownLocator: props.lastKnownLocator }),
        // The entry's own forge repository, exactly as its source declared it.
        // It travels from the observation the reader is looking at, so launch
        // placement joins on the same answer the screen is showing rather than
        // re-reading the entry.
        ...(props.repository === undefined ? {} : { repository: props.repository }),
        ...(props.reviewWorkspace === undefined ? {} : { reviewWorkspace: props.reviewWorkspace }),
        ...(comparisonSource === undefined ? {} : { comparisonSource }),
      });
      return null;
    })();
  }, [controller, props, readComparison]);
  const walk = React.useCallback(() => {
    if (reading.current || props.target.kind !== 'entry') return;
    const target = props.target;
    reading.current = true;
    setReadingComparison(true);
    setComparisonFailed(false);
    void (async () => {
      try {
        const comparison = await readComparison();
        if (!mounted.current) return;
        if (comparison?.kind !== 'pullRequest') { setComparisonFailed(true); return; }
        const action: TriageActionV1 = {
          actionId: 'walk-comparison', label: 'Walk through', enabled: true,
          appliesTo: ['pullRequest'], profileId: null, workspaceMode: 'reference_only',
          target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        };
        controller.start({
          action, entryRef: target.entryRef, display: props.display,
          sourceInstance: { source: target.entryRef.source, sourceInstanceId: target.sourceInstanceId },
          presentation: props.presentation,
          comparisonDestination: { kind: 'scmReview', comparison, view: 'walkthrough' },
          linkedSessionIds: props.linkedSessionIds,
          ...(props.lastKnownLocator === undefined ? {} : { lastKnownLocator: props.lastKnownLocator }),
          ...(props.repository === undefined ? {} : { repository: props.repository }),
        });
      } catch {
        if (mounted.current) setComparisonFailed(true);
      } finally {
        reading.current = false;
        if (mounted.current) setReadingComparison(false);
      }
    })();
  }, [controller, props, readComparison]);
  const retireReviewChooser = React.useCallback(() => {
    controller.reset();
  }, [controller]);
  const notice = describeTriageEntrySessionPhaseV1(controller.phase);

  return (
    <Stack gap="small">
      <TriageEntryActionControls
        target={props.target}
        actions={props.actions.actions}
        workflowSubject={props.workflowSubject}
        viewerIsAuthor={props.viewerIsAuthor}
        preparesReviewWorkspace={props.reviewWorkspace !== undefined}
        onAction={onAction}
        trailing={props.attention}
        overflow={props.workflowSubject === 'pullRequest' && props.comparisonRead !== undefined
          || props.sourceActions !== undefined ? (
            <>
              {props.workflowSubject === 'pullRequest' && props.comparisonRead !== undefined ? (
                <Button titleKey="plugins.triage.surface.walkthrough" title="Walk through"
                  variant="plain" size="small" disabled={readingComparison} onPress={walk} />
              ) : null}
              {props.sourceActions}
            </>
          ) : undefined}
      />
      {controller.review === null ? null : (
        <TriagePullRequestReviewChooser
          pending={controller.review}
          onFinished={retireReviewChooser}
        />
      )}
      {notice === null ? null : (
        <Status tone={notice.tone} labelKey={notice.labelKey} label={notice.label} />
      )}
      {comparisonFailed ? <Status tone="warning"
        labelKey="plugins.triage.surface.comparisonUnavailable"
        label="This source cannot open a comparison for this pull request." /> : null}
    </Stack>
  );
}

/**
 * §2.2's common header, rendered once for both the states it has.
 *
 * The mounted detail and a selection the window has stopped listing show the
 * same facts about the same entry and differ only in whether they are current,
 * so they are one renderer with one marker rather than two blocks that drift.
 */
/**
 * The entry's kind glyph in the row's own tone, beside the detail title. It stands on its own (no tile): the
 * same mark the row wears, read through the row's mark owner.
 */
export function TriageDetailKindMark(props: Readonly<{ header: TriageDetailHeaderV1 }>): React.ReactElement {
  const mark = readTriageRowMarkV1(props.header.markFacts, props.header.workflowSubject);
  return <Icon name={mark.name} tone={mark.tone} />;
}

/** The source's brand mark leading the detail line. */
export function TriageDetailSourceMark(props: Readonly<{ pluginId: string }>): React.ReactElement {
  return <BrandMark pluginId={props.pluginId} size="small" externallyLabelled />;
}

export function TriageDetailHeaderView(props: TriageDetailHeaderViewProps): React.ReactElement {
  const text = usePluginTranslation();
  const surfaceContext = useSurfaceContext();
  const header = props.header;
  const contextLine = readTriageDetailContextLineV1(header, text, { locale: surfaceContext.locale, nowMs: Date.now() });
  const presenceCopy = header.presence === 'present'
    ? null
    : header.presence === 'absent'
      ? text('plugins.triage.surface.detail.entryAbsent', PRESENCE_COPY.absent ?? '')
      : text('plugins.triage.surface.detail.entryUnresolved', PRESENCE_COPY.unresolved ?? '');
  return (
    <>
      {props.headerHosted ? null : (
        <Row gap="small" align="center">
          <TriageDetailKindMark header={header} />
          <Stack style={DETAIL_TITLE_STYLE_V1}><Heading level={2} value={header.title} /></Stack>
          <Row gap="xsmall" align="center">
            <TriageDetailHeaderActions header={header} pin={props.pin} />
            <IconButton icon={<Icon name="close" tone="secondary" />} accessibilityLabel={text('plugins.triage.surface.close', 'Close')} onPress={props.onClose} />
          </Row>
        </Row>
      )}
      {props.headerHosted || contextLine === null ? null : (
        <Row gap="xsmall" align="center">
          <TriageDetailSourceMark pluginId={header.sourcePluginId} />
          <Stack style={DETAIL_TITLE_STYLE_V1}><Text variant="caption" tone="secondary" value={contextLine} numberOfLines={1} /></Stack>
        </Row>
      )}
      {props.lastKnown === true ? <Status tone="muted" labelKey="plugins.triage.surface.detail.lastKnown" label="These are the last facts this page held for this entry, and they may be out of date." /> : null}
      {header.attention === null || props.attentionInActions === true ? null : <TriageAttentionBadge attention={header.attention} />}
      {presenceCopy === null ? null : <Status tone="warning" label={presenceCopy} />}
      {header.sourceReadFailed ? <Status tone="muted" labelKey="plugins.triage.surface.detail.connectionUnhealthy" label="This connection could not be read in the last pass." /> : null}
      {props.showLinkedSessions === false ? null : <TriageLinkedSessions key={props.instanceKey} sessions={header.linkedSessions} hasMore={header.linkedSessionsHasMore} pageState={props.linkedSessionsPageState} onLoadMore={props.onLoadMoreLinkedSessions} onSelect={props.onSelectLinkedSession} />}
    </>
  );
}

/** The same selected-entry actions in either the inline identity row or the host band. */
export function TriageDetailHeaderActions(props: Readonly<{ header: TriageDetailHeaderV1; pin?: TriageDetailPinActionV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const pinLabel = props.pin === undefined
    ? null
    : readTriagePinActionLabelV1(props.pin.row, text);
  const pinBusy = props.pin !== undefined && props.pin.handlers.busyKey === props.pin.row.key;
  const onSetPinned = React.useCallback(() => {
    if (props.pin !== undefined) props.pin.handlers.onSetPinned(props.pin.row);
  }, [props.pin]);
  const webUrl = props.header.webUrl;
  const openAtSource = React.useCallback(
    () => (webUrl === null ? undefined : hostApi.openExternalLink(webUrl)),
    [hostApi, webUrl],
  );

  return (
    <Row gap="xsmall" align="center">
      {props.pin === undefined || pinLabel === null ? null : (
        <IconButton
          icon={<Icon name="pin" tone={props.pin.row.pinned ? 'accent' : 'secondary'} />}
          accessibilityLabel={pinLabel}
          selected={props.pin.row.pinned}
          busy={pinBusy}
          disabled={props.pin.handlers.unavailableReason !== null}
          onPress={onSetPinned}
        />
      )}
      {webUrl === null ? null : (
        <IconButton
          icon={<Icon name="external" tone="secondary" />}
          accessibilityLabel={text('plugins.triage.surface.detail.openAtSource', 'Open at the source')}
          onPress={openAtSource}
        />
      )}
    </Row>
  );
}

export function TriageDetailRegion(props: TriageDetailRegionProps): React.ReactElement {
  const context = useSurfaceContext();
  const hostApi = usePluginHostApi();
  const text = usePluginTranslation();
  // The ONE Triage consumer of a source disclosure, mounted for exactly as long
  // as this detail is: it binds the retained origin address and owns the single
  // revision-checked transaction the disclosed candidate becomes.
  const insertion = useTriageTierBEvidenceInsertion(props.originComposer);
  const evidenceDisclosure = React.useMemo(() => ({ ...insertion, panelActions: props.sourcePanelActions }), [insertion, props.sourcePanelActions]);
  const row = props.row;
  const sessionSelection = props.sessionSelection;
  const selectedSessionId = sessionSelection.value;
  const tabSelection = props.tabSelection;
  const selectInlineSession = sessionSelection.onChange;
  const selectPanelSession = sessionSelection.onChange;
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
  const sourceDescriptor = readTriageSourceDescriptorV1(context, row.entryRef.source);
  const header = React.useMemo(() => projectTriageDetailHeaderV1({
    row,
    lanes: props.lanes,
    connectionLabel: props.connectionLabel,
    sourceDescriptor,
    linkedSessions,
    linkedSessionsHasMore,
    text,
  }), [linkedSessions, linkedSessionsHasMore, props.connectionLabel, props.lanes, row, sourceDescriptor, text]);

  const completePostMutation = props.completePostMutation;

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
  const prepareReviewWorkspaceOperation = readTriageSourcePrepareReviewWorkspaceOperationV1(
    context,
    row.entryRef.source,
  );
  const display = React.useMemo(() => (
    observation === null
      ? null
      : { locator: observation.locator, scopeLabel: observation.snapshot.scopeLabel }
  ), [observation]);
  const workflowSubject = header.workflowSubject;
  const snapshot = observation?.snapshot;
  const locator = observation?.locator;
  // Which tabs this entry's kind declares, joined with its linked fix PR's
  // (r0.42). The link is owned by `useTriageFixPullRequests`; an issue or error
  // group retains the linked PR's declared tabs even while its mount is unavailable.
  const declaredKind = sourceDescriptor?.kinds.find((kind) => kind.id === row.entryRef.kindId);
  const fixDisplay = React.useMemo(() => (
    snapshot === undefined ? null : { title: snapshot.title, scopeLabel: snapshot.scopeLabel }
  ), [snapshot]);
  const fixPullRequest = useTriageDetailFixPullRequest({
    context,
    row,
    rows: props.rows,
    workflowSubject,
    display: fixDisplay,
  });
  const fixTabs = fixPullRequest.detailTabs;
  const fixFacts = fixPullRequest.facts;
  const entryFacts = snapshot?.facts;
  const composition = React.useMemo(() => planTriageDetailTabsV1({
    workflowSubject,
    entryTabs: declaredKind?.detailTabs,
    ...(entryFacts === undefined ? {} : { entryFacts }),
    fixPullRequest: fixTabs === undefined ? null : { detailTabs: fixTabs, ...(fixFacts === undefined ? {} : { facts: fixFacts }) },
  }), [declaredKind, entryFacts, fixFacts, fixTabs, workflowSubject]);
  const reportAvailableTabs = props.tabSelection.onAvailableTabsChange;
  React.useLayoutEffect(() => {
    if (composition.kind === 'whole' && header.linkedSessions.length === 0) reportAvailableTabs?.([]);
  }, [composition.kind, header.linkedSessions.length, reportAvailableTabs]);
  // The most recent linked Session, read live through the host's canonical
  // Session projection (r0.42): one watch feeds both the permission card and
  // the agent step.
  const liveSessionId = header.linkedSessions[0]?.sessionId ?? null;
  const liveSession = useSessionState(composition.kind === 'tabs' ? liveSessionId : null);
  const reviewEntry = React.useMemo(() => (
    workflowSubject === 'pullRequest'
      ? { kind: 'pullRequest' as const, ...(locator?.webUrl === undefined ? {} : { url: locator.webUrl }) }
      : { kind: 'issue' as const, id: createReviewCommentLinkedIssueIdV1(row.entryRef) }
  ), [locator, row.entryRef, workflowSubject]);
  const admittedSurface = lookup.kind === 'admitted' ? lookup.surface : null;
  const entryMount = React.useMemo<TriageDetailSourceMountV1 | null>(() => (
    detail?.kind === 'ready' && admittedSurface !== null
      ? {
          surface: admittedSurface,
          input: detail.input,
          instanceKey: deriveTriageDetailMountInstanceKey(row.entryRef, detail.input.instance.instance.sourceInstanceId),
        }
      : null
  ), [admittedSurface, detail, row.entryRef]);
  const repository = selected?.repository;
  const actionPresentation = React.useMemo(() => (
    snapshot === undefined
      ? null
      : buildTriageEntryAttachmentPresentation({
          title: snapshot.title,
          scopeLabel: snapshot.scopeLabel,
        })
  ), [snapshot]);
  const reviewWorkspace = React.useMemo(() => {
    if (
      prepareReviewWorkspaceOperation === undefined
      || detail?.kind !== 'ready'
      || observation === null
      || snapshot?.reviewRevision === undefined
      || locator === undefined
    ) return undefined;
    return {
      operation: prepareReviewWorkspaceOperation,
      preparation: {
        instance: detail.input.instance,
        entryRef: row.entryRef,
        lastKnownLocator: locator,
        observed: {
          ...snapshot.reviewRevision,
          observedAtMs: observation.observedAtMs,
        },
      },
    };
  }, [detail, locator, observation, prepareReviewWorkspaceOperation, row.entryRef, snapshot]);
  const getOperation = readTriageSourceGetOperationV1(context, row.entryRef.source);
  const comparisonRead = React.useMemo(() => getOperation !== undefined && detail?.kind === 'ready'
    ? { operation: getOperation, instance: detail.input.instance } : undefined, [detail, getOperation]);
  const linkedSessionIds = React.useMemo(() => header.linkedSessions.map((session) => session.sessionId), [header.linkedSessions]);
  const reportLinkedSessions = sessionSelection.onAvailableSessionsChange;
  React.useLayoutEffect(() => { reportLinkedSessions(header.linkedSessions); }, [header.linkedSessions, reportLinkedSessions]);
  // The source's own write controls (merge, close, reviewers…): its `actions` panel, held in the header's More
  // beside Triage's entry actions (r0.42) rather than as a form above the tabs.
  const sourceActions = composition.kind === 'tabs' && declaredKind?.detailActions === true && entryMount !== null ? (
    <TriagePostMutationCompletionProvider onComplete={completePostMutation}>
      <TriageDetailPanelMount
        mount={{
          ...entryMount,
          instanceKey: deriveTriageDetailMountInstanceKey(
            row.entryRef,
            entryMount.input.instance.instance.sourceInstanceId,
            'actions',
          ),
        }}
        panel={TRIAGE_DETAIL_ACTIONS_PANEL_V1}
        fallback={null}
      />
    </TriagePostMutationCompletionProvider>
  ) : undefined;
  const actionRegionShown = workflowSubject !== null && display !== null && actionPresentation !== null && selected !== null;
  const viewerIsAuthor = row.content?.outcome.viewer.involvement.includes('author') === true;
  const attention = header.attention === null ? undefined : (
    <TriageAttentionBadge attention={header.attention} />
  );
  return (
    <Stack gap="medium" style={DETAIL_FILL_STYLE_V1}>
      <ScrollArea style={DETAIL_HEADER_SCROLL_STYLE_V1}>
      <Stack gap="small">
      <TriageDetailHeaderView
        headerHosted={props.headerHosted}
        header={header}
        {...(selected === null ? {} : {
          instanceKey: deriveTriageDetailMountInstanceKey(row.entryRef, selected.sourceInstanceId),
        })}
        pin={props.pin}
        onClose={props.onClose}
        showLinkedSessions={composition.kind === 'whole'}
        attentionInActions={actionRegionShown}
        onSelectLinkedSession={selectInlineSession}
        {...(detail?.kind === 'ready' ? {
          linkedSessionsPageState: detail.linkedSessionsPageState,
          onLoadMoreLinkedSessions: detail.loadMoreLinkedSessions,
        } : {})}
      />

      {!actionRegionShown || workflowSubject === null || display === null || actionPresentation === null
        || selected === null ? null : (
          <TriageEntryScopedActionRegion
            key={deriveTriageDetailMountInstanceKey(row.entryRef, selected.sourceInstanceId)}
            target={props.target}
            actions={props.actions}
            workflowSubject={workflowSubject}
            display={display}
            presentation={actionPresentation}
            linkedSessionIds={linkedSessionIds}
            {...(comparisonRead === undefined ? {} : { comparisonRead })}
            {...(locator === undefined ? {} : { lastKnownLocator: locator })}
            {...(repository === undefined ? {} : { repository })}
            {...(reviewWorkspace === undefined ? {} : { reviewWorkspace })}
            viewerIsAuthor={viewerIsAuthor}
            {...(sourceActions === undefined ? {} : { sourceActions })}
            {...(attention === undefined ? {} : { attention })}
          />
        )}
      {actionRegionShown ? null : sourceActions}
      </Stack>
      </ScrollArea>

      <Stack style={DETAIL_FILL_STYLE_V1}>
      {observation === null ? (
        <EmptyState
          titleKey="plugins.triage.surface.detail.noConnection.title"
          title="No connection to open this through"
          descriptionKey="plugins.triage.surface.detail.noConnection.description"
          description="No configured connection currently observes this entry, so there is nothing to read it with."
        />
      ) : detail === null || detail.kind === 'reading' ? (
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
          action={(
            <Button
              titleKey="plugins.triage.surface.actions.retry"
              title="Retry"
              variant="secondary"
              onPress={detail.retry}
            />
          )}
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
      ) : composition.kind === 'tabs' && entryMount !== null ? (
        <TriagePostMutationCompletionProvider onComplete={completePostMutation}>
          <TriageEvidenceDisclosureProvider disclosure={evidenceDisclosure}>
            <TriageDetailTabbedBody
              key={entryMount.instanceKey}
              tabs={composition.tabs}
              tabSelection={tabSelection}
              entry={entryMount}
              fixPullRequest={fixPullRequest.mount}
              overviewLead={liveSession.state === null || liveSessionId === null ? null : (
                liveSession.state.pendingPermissions.map((request) => (
                  <TriagePermissionCard
                    key={request.requestId}
                    sessionId={liveSessionId}
                    sessionTitle={header.linkedSessions[0]?.displayTitle}
                    request={request}
                  />
                ))
              )}
              overviewTail={(
                <>
                  {fixPullRequest.state !== null ? (
                    <TriageFixPullRequests state={fixPullRequest.state} pickable={fixPullRequest.pickable} />
                  ) : null}
                  <TriageAgentStep
                    onSelectSession={selectInlineSession}
                    sessions={header.linkedSessions}
                    hasMore={header.linkedSessionsHasMore}
                    live={liveSession}
                    reviewEntry={reviewEntry}
                    {...(detail.kind === 'ready' ? {
                      pageState: detail.linkedSessionsPageState,
                      onLoadMore: detail.loadMoreLinkedSessions,
                    } : {})}
                  />
                </>
              )}
              activityTail={(
                <TriageAgentStep
                  onSelectSession={selectInlineSession}
                  variant="card"
                  sessions={header.linkedSessions}
                  hasMore={false}
                  live={liveSession}
                  reviewEntry={reviewEntry}
                />
              )}
              {...(header.linkedSessions.length === 0 ? {} : {
                session: <TriageSessionPanel sessions={header.linkedSessions} selectedSessionId={selectedSessionId} onSelectSession={selectPanelSession} />,
              })}
              fallback={(
                <EmptyState
                  titleKey="plugins.triage.surface.detail.mountError.title"
                  title="This source's detail view is unavailable"
                  descriptionKey="plugins.triage.surface.detail.mountError.description"
                  description="Happier could not mount the source's own view of this entry. The facts above are what the aggregate already knows."
                />
              )}
            />
          </TriageEvidenceDisclosureProvider>
        </TriagePostMutationCompletionProvider>
      ) : (
        <TriageDetailWholeBody
          key={deriveTriageDetailMountInstanceKey(row.entryRef, detail.input.instance.instance.sourceInstanceId)}
          sessions={header.linkedSessions}
          tabSelection={tabSelection}
          selectedSessionId={selectedSessionId}
          onSelectSession={selectPanelSession}
        >
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
        </TriageDetailWholeBody>
      )}
      </Stack>
    </Stack>
  );
}

/** The entry's attention reason as the detail's chip: the row chip's tone and mark (one owner for both). */
function TriageAttentionBadge(props: Readonly<{ attention: NonNullable<TriageDetailHeaderV1['attention']> }>): React.ReactElement {
  const { attention } = props;
  const icon = attention.icon !== null && isHappierIconName(attention.icon) ? attention.icon : undefined;
  return (
    <Badge
      variant="tinted"
      tone={readTriageAttentionBadgeToneV1(attention.level)}
      value={attention.reasonLabel}
      {...(icon === undefined ? {} : { icon })}
    />
  );
}
