import * as React from 'react';
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

import { readTriageActionTitleKeyV1, type TriageActionV1 } from '../../settings/actions.js';
import type { TriageBulkSessionDestinationV1 } from './bulkSessionPlan.js';
import { isTriageBulkEntryOutcomeIncompleteV1 } from './bulkSessionOutcome.js';
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
 * **The offered actions are not filtered by workflow subject here, and that is
 * deliberate.** `appliesTo` is answered against an entry's declared kind, whose
 * only producer is that entry's own source descriptor — a fact the list surface
 * does not hold and a bulk selection may span several of. Offering the reader
 * their own configured actions and reporting per-unit refusals truthfully is
 * better than hiding actions behind a guess; the single-entry controls, which
 * DO know the subject, keep filtering.
 */

export type TriageBulkActionBarPropsV1 = Readonly<{
  /** The configured catalog, in stored order. Disabled actions are never offered. */
  actions: readonly TriageActionV1[];
  phase: TriageBulkSessionsPhaseV1;
  onRun: (input: Readonly<{
    action: TriageActionV1;
    destination: TriageBulkSessionDestinationV1;
    keys: readonly string[];
  }>) => void;
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

export function TriageBulkActionBar(props: TriageBulkActionBarPropsV1): React.ReactElement | null {
  const text = usePluginTranslation();
  const snapshot = useListMultiSelectionSnapshot();
  const offered = React.useMemo(
    () => props.actions.filter((action) => action.enabled),
    [props.actions],
  );
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  // The reader's own pick when they made one and it still exists; otherwise the
  // first offered action. Reading it this way rather than syncing state in an
  // effect means a catalog that changes under the bar can never leave it
  // pointing at an action that is gone.
  const action = offered.find((candidate) => candidate.actionId === selectedActionId) ?? offered[0];

  if (!snapshot.isSelectionMode || action === undefined) return null;
  const busy = props.phase.kind === 'resolving'
    || props.phase.kind === 'choosing'
    || props.phase.kind === 'starting';

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
    const opened = phase.results.filter((result) => result.status === 'settled').length;
    const unknown = phase.results.filter((result) => result.status === 'unknownOutcome').length;
    const notStarted = phase.results.filter((result) => result.status === 'notStarted').length;
    const incompleteEntries = phase.results.flatMap((result) => (
      result.status === 'settled'
        ? result.outcome.entries.filter(isTriageBulkEntryOutcomeIncompleteV1)
        : []
    )).length;
    const left = phase.unavailableKeys.length + phase.refusals.length + incompleteEntries;
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
