import * as React from 'react';
import type { TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';
import {
  Button,
  Form,
  List,
  Row,
  Stack,
  Status,
  useListMultiSelectionSnapshot,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import {
  planTriageOfferableActionsV1,
  planTriageOfferedActionsV1,
  readTriageActionTitleKeyV1,
  type TriageActionV1,
} from '../../settings/actions.js';
import type { TriageBulkSessionDestinationV1 } from './bulkSessionPlan.js';
import { summarizeTriageBulkSettlementV1 } from './bulkSessionOutcome.js';
import type {
  TriageBulkSessionsPhaseV1,
  TriageBulkUnavailableReasonV1,
} from './useBulkEntrySessions.js';

/**
 * What a bulk selection can be turned into (`PLAN.md` §0a A6).
 *
 * The bar answers two questions and hands both to one owner: WHICH configured
 * action the press applies — its profile, its prompt, its workspace mode and
 * its delivery, resolved once for the whole press — and WHICH of the three
 * destinations it lands in. It decides nothing else: it starts nothing, mints
 * nothing, and reads no outcome it was not handed.
 *
 * The selected set itself belongs to the shared `List`'s own selection store,
 * which is also what makes this bar appear at all: it renders only while a
 * selection is live, through the public `List.SelectionActionBar`, so the count
 * on screen and the keys a press acts on are one fact rather than two.
 *
 * **The offered actions ARE filtered by workflow subject**, through the same
 * `planTriageOfferedActionsV1` owner the single-entry controls use. `appliesTo`
 * answers which subjects an action is offered on, and a bulk selection may span
 * several of them, so the bar offers an action when AT LEAST ONE selected entry
 * is offered it and keeps the configured order. It resolves no subject itself:
 * the shell owns the exact admitted source descriptor each selected row was
 * projected from and answers `selectedWorkflowSubjects` from it, so this bar and
 * the press it starts read one fact rather than two.
 *
 * A selection whose subjects cannot be resolved at all — a row retained from a
 * source contribution that is no longer admitted — narrows nothing, because
 * hiding every action behind an absent fact is a guess in the other direction.
 * The press then reports the per-entry `workflowSubjectUnavailable` refusal.
 */

export type TriageBulkActionBarPropsV1 = Readonly<{
  /** The configured catalog, in stored order. Disabled actions are never offered. */
  actions: readonly TriageActionV1[];
  /**
   * The DISTINCT workflow subjects the shell resolved for the live selection,
   * from the exact admitted source contribution each selected row carries. An
   * empty answer means no selected row currently resolves one.
   */
  selectedWorkflowSubjects: (keys: readonly string[]) => readonly TriageSourceWorkflowSubjectV1[];
  phase: TriageBulkSessionsPhaseV1;
  onRun: (input: Readonly<{
    action: TriageActionV1;
    destination: TriageBulkSessionDestinationV1;
    keys: readonly string[];
  }>) => void;
  retryable: boolean;
  onRetry: () => void;
  onCancel: () => void;
}>;

const DESTINATIONS: readonly Readonly<{
  destination: TriageBulkSessionDestinationV1;
  labelKey: string;
  fallback: string;
}>[] = Object.freeze([
  {
    destination: 'oneSessionForAllEntries',
    labelKey: 'plugins.triage.surface.bulk.oneSession',
    fallback: 'One session for all',
  },
  {
    destination: 'oneSessionPerEntry',
    labelKey: 'plugins.triage.surface.bulk.sessionPerEntry',
    fallback: 'A session each',
  },
  {
    destination: 'attachAllToNewSession',
    labelKey: 'plugins.triage.surface.bulk.newSession',
    fallback: 'Attach to New Session',
  },
]);

function destinationOf(actionId: string): TriageBulkSessionDestinationV1 | null {
  const found = DESTINATIONS.find((candidate) => candidate.destination === actionId);
  return found?.destination ?? null;
}

function isSameSelection(
  selected: ReadonlySet<string>,
  resultKeys: readonly string[],
): boolean {
  return selected.size === resultKeys.length && resultKeys.every((key) => selected.has(key));
}

/** No control exists to press, so no press can arrive. */
const NO_DESTINATIONS: readonly [] = Object.freeze([]);
const IGNORE_PRESS = (): void => undefined;

export function TriageBulkActionBar(props: TriageBulkActionBarPropsV1): React.ReactElement | null {
  const text = usePluginTranslation();
  const snapshot = useListMultiSelectionSnapshot();
  const selectedWorkflowSubjects = props.selectedWorkflowSubjects;
  // The set's own identity is the dependency: the shared store replaces it only
  // when the selection actually changed, so this resolves once per change
  // rather than on every render of the list around it.
  const subjects = React.useMemo(
    () => selectedWorkflowSubjects([...snapshot.selectedKeys]),
    [selectedWorkflowSubjects, snapshot.selectedKeys],
  );
  const offered = React.useMemo(() => {
    const offerable = planTriageOfferableActionsV1(props.actions);
    if (subjects.length === 0) return offerable;
    // The union across the selected subjects, decided by the ONE offer owner
    // and then read back in configured catalog order — the order is a person's
    // configuration, not something this bar reapplies.
    const applicable = new Set<TriageActionV1>();
    for (const subject of subjects) {
      for (const action of planTriageOfferedActionsV1(props.actions, subject)) applicable.add(action);
    }
    return offerable.filter((candidate) => applicable.has(candidate));
  }, [props.actions, subjects]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  // The reader's own pick when they made one and it still exists; otherwise the
  // first offered action. Reading it this way rather than syncing state in an
  // effect means a catalog that changes under the bar can never leave it
  // pointing at an action that is gone.
  const action = offered.find((candidate) => candidate.actionId === selectedActionId) ?? offered[0];

  if (!snapshot.isSelectionMode) return null;
  const busy = props.phase.kind === 'resolving'
    || props.phase.kind === 'choosing'
    || props.phase.kind === 'starting';

  if (action === undefined) {
    // The count and the Clear control belong to the shared bar and stay: a
    // reader who has selected rows must always be able to see how many and let
    // them go, and disappearing on them is how the previous unfiltered offer
    // would have had to hide a dead end.
    return (
      <Stack gap="small">
        <List.SelectionActionBar
          accessibilityLabel={text('plugins.triage.surface.bulk.label', 'Bulk actions')}
          testID="triage-bulk-action-bar"
          actions={NO_DESTINATIONS}
          onAction={IGNORE_PRESS}
        />
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.bulk.noApplicableActions"
          label="None of your configured actions can run on the entries you selected."
        />
      </Stack>
    );
  }

  return (
    <Stack gap="small">
      {offered.length < 2 ? null : (
        <Form.Select
          label={text('plugins.triage.surface.bulk.action', 'Action')}
          options={offered.map((candidate) => {
            const titleKey = readTriageActionTitleKeyV1(candidate);
            return {
              value: candidate.actionId,
              label: titleKey === null ? candidate.label : text(titleKey, candidate.label),
            };
          })}
          value={action.actionId}
          disabled={busy}
          onChange={(value) => {
            if (typeof value === 'string') setSelectedActionId(value);
          }}
        />
      )}
      <List.SelectionActionBar
        accessibilityLabel={text('plugins.triage.surface.bulk.label', 'Bulk actions')}
        testID="triage-bulk-action-bar"
        actions={DESTINATIONS.map((candidate) => ({
          id: candidate.destination,
          label: text(candidate.labelKey, candidate.fallback),
          disabled: busy,
          testID: `triage-bulk-${candidate.destination}`,
        }))}
        onAction={(actionId, keys) => {
          const destination = destinationOf(actionId);
          if (destination === null) return;
          props.onRun({ action, destination, keys });
        }}
      />
      <Row gap="small" align="center">
        <TriageBulkPhaseStatus phase={props.phase} />
        {props.phase.kind !== 'settled'
          || !props.retryable
          || !isSameSelection(snapshot.selectedKeys, props.phase.selectionKeys) ? null : (
          <Button
            titleKey="plugins.triage.surface.bulk.retry"
            title="Try again"
            variant="secondary"
            onPress={props.onRetry}
          />
        )}
        {!busy ? null : (
          <Button
            titleKey="plugins.triage.surface.bulk.cancel"
            title="Stop"
            variant="plain"
            onPress={props.onCancel}
          />
        )}
      </Row>
    </Stack>
  );
}

/**
 * What the press is doing, and what it did.
 *
 * Every arm is a sentence a reader can act on. A partly-settled run is reported
 * as exactly that — how many Sessions the press opened, how many it could not
 * observe the outcome of, and how many selected rows carried nothing to start
 * from — rather than as one verdict for the whole press, because those are
 * different things to be told and only the first of them is finished.
 */
function TriageBulkPhaseStatus(props: Readonly<{
  phase: TriageBulkSessionsPhaseV1;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const phase = props.phase;
  if (phase.kind === 'idle') return null;
  if (phase.kind === 'resolving' || phase.kind === 'choosing') {
    return (
      <Status
        tone="info"
        pulsing
        label={text('plugins.triage.surface.bulk.resolving', 'Preparing…')}
      />
    );
  }
  if (phase.kind === 'starting') {
    return (
      <Status
        tone="info"
        pulsing
        label={text('plugins.triage.surface.bulk.starting', 'Starting {started} of {total}…', {
          started: String(phase.started),
          total: String(phase.total),
        })}
      />
    );
  }
  if (phase.kind === 'seeded') {
    const applied = phase.outcomes.filter((outcome) => outcome.newSessionSeed === 'applied').length;
    const refused = phase.outcomes.length - applied + phase.refusals.length;
    const seeded = (
      <Status
        tone={refused === 0 ? 'success' : 'warning'}
        label={text('plugins.triage.surface.bulk.seeded', '{count} attached to New Session', {
          count: String(applied),
        })}
      />
    );
    if (refused === 0) return seeded;
    return (
      <Stack gap="small">
        {seeded}
        <Status
          tone="warning"
          label={text(
            'plugins.triage.surface.bulk.settled',
            '{opened} started, {unknown} unconfirmed, {notStarted} not started, {left} could not be used',
            { opened: '0', unknown: '0', notStarted: '0', left: String(refused) },
          )}
        />
      </Stack>
    );
  }
  if (phase.kind === 'settled') {
    const { opened, unknown, notStarted, left } = summarizeTriageBulkSettlementV1({
      results: phase.results,
      unavailableCount: phase.unavailableKeys.length,
      refusalCount: phase.refusals.length,
    });
    return (
      <Status
        tone={unknown > 0 || left > 0 || notStarted > 0 ? 'warning' : 'success'}
        label={text(
          'plugins.triage.surface.bulk.settled',
          '{opened} started, {unknown} unconfirmed, {notStarted} not started, {left} could not be used',
          {
            opened: String(opened),
            unknown: String(unknown),
            notStarted: String(notStarted),
            left: String(left),
          },
        )}
      />
    );
  }
  const copy = UNAVAILABLE_COPY[phase.reason];
  return <Status tone="warning" labelKey={copy.key} label={copy.fallback} />;
}

/**
 * Why nothing was started, in the reader's own language.
 *
 * The keys are literals in a table rather than a template built from the
 * reason, because the catalog's own completeness check reads the SOURCE for
 * key literals: a computed key is invisible to it, ships undefined in every
 * locale, and renders English to everyone with nothing failing.
 */
const UNAVAILABLE_COPY: Readonly<Record<
  TriageBulkUnavailableReasonV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  newSessionUnsupported: {
    key: 'plugins.triage.surface.bulk.newSessionUnsupported',
    fallback: 'This screen cannot open the New Session surface, so nothing was started.',
  },
  newSessionUnavailable: {
    key: 'plugins.triage.surface.bulk.newSessionUnavailable',
    fallback: 'The New Session surface did not settle on something a session can be started from.',
  },
  checkoutRequiresNewSessionAuthoring: {
    key: 'plugins.triage.surface.bulk.checkoutRequiresNewSessionAuthoring',
    fallback: 'This action needs a new checkout. Use Attach to New Session so you can choose where to create it.',
  },
  composeRequiresNewSessionAuthoring: {
    key: 'plugins.triage.surface.bulk.composeRequiresNewSessionAuthoring',
    fallback: 'This action needs review before sending. Use Attach to New Session so its prompt and entries are ready before anything starts.',
  },
  preparedWorkspaceUnsupported: {
    key: 'plugins.triage.surface.bulk.preparedWorkspaceUnsupported',
    fallback: 'This action needs a review workspace prepared by the source, so nothing was started.',
  },
  reviewStartUnsupported: {
    key: 'plugins.triage.surface.bulk.reviewStartUnsupported',
    fallback: 'A formal code review cannot be started in bulk from here, so nothing was started.',
  },
  // The four reference refusals. A bulk press resolves the action's profile and
  // prompt ONCE for the whole selection, so a broken reference stops everything
  // before a single Session exists — which is the point of resolving first.
  profileMissing: {
    key: 'plugins.triage.surface.bulk.profileMissing',
    fallback: 'This action\u2019s launch profile no longer exists, so nothing was started. Pick another one in Configure actions.',
  },
  profileUnavailable: {
    key: 'plugins.triage.surface.bulk.profileUnavailable',
    fallback: 'Happier could not read your launch profiles, so nothing was started. Try again in a moment.',
  },
  promptMissing: {
    key: 'plugins.triage.surface.bulk.promptMissing',
    fallback: 'This action\u2019s prompt no longer exists in your Prompt Library, so nothing was started. Pick another one in Configure actions.',
  },
  promptInvalid: {
    key: 'plugins.triage.surface.bulk.promptInvalid',
    fallback: 'This action\u2019s prompt resolved to no content, so nothing was started. Edit the prompt before trying again.',
  },
  promptUnavailable: {
    key: 'plugins.triage.surface.bulk.promptUnavailable',
    fallback: 'Happier could not read this action\u2019s prompt, so nothing was started. Try again in a moment.',
  },
  dispatch: {
    key: 'plugins.triage.surface.bulk.dispatch',
    fallback: 'Nothing was started: this screen could not reach the sessions it asked for.',
  },
  noEntriesAvailable: {
    key: 'plugins.triage.surface.bulk.noEntriesAvailable',
    fallback: 'None of the selected entries can be started right now, so nothing was started.',
  },
});
