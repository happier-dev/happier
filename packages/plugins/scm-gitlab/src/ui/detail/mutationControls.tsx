/**
 * The GitLab merge-request writes, as controls a person can actually press.
 *
 * The three Actions have existed and been tested for a while; what did not exist
 * was anything that renders them, and an Action a Triage source's detail renderer
 * does not render is an Action nobody can reach. This file is that rendering, and
 * nothing more:
 *
 * - **No confirmation is asked here.** Each write declares host-owned
 *   confirmation metadata in the manifest, and the canonical Action gate raises
 *   it before the handler runs. A second "are you sure" in this panel would be a
 *   competing owner of one decision, and the one the user answered would be the
 *   one that did not count.
 * - **No input is composed by hand.** Every dispatch payload is built by
 *   `./mutations.js` through the write contract's own schema, so a payload this
 *   panel cannot legally form becomes an absent control rather than a button
 *   whose every press is rejected at the daemon.
 * - **No outcome is flattened.** A merge that was SCHEDULED is not a merge; a
 *   refusal that never left this process is not a failure; and a write whose
 *   confirming read could not settle may already have landed. Each is reported as
 *   itself, because the alternative is a user pressing merge twice.
 *
 * The head-pinned writes (merge, mark-ready) are offered only when their pin can
 * be built from the mounted observation. GitLab consumes that pin as its own
 * `sha` precondition, and a merge dispatched without it is unconditional — so an
 * unavailable pin withholds the control, and says so, instead of quietly
 * widening the write. Close needs no pin and is offered regardless, because
 * removing a capability that works is its own defect.
 */

import * as React from 'react';
import {
  Banner,
  Button,
  Row,
  Stack,
  Text,
  useExecutePluginAction,
  usePluginTranslation,
  type PluginTranslate,
  type TextTone,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../triage/contribution.js';
import type {
  GitlabMergeRequestCloseInputV1,
  GitlabMergeRequestMarkReadyInputV1,
  GitlabMergeRequestMergeInputV1,
} from '../../triage/mutations/contracts.js';
import {
  buildGitlabMergeRequestCloseInputV1,
  buildGitlabMergeRequestMarkReadyInputV1,
  buildGitlabMergeRequestMergeInputV1,
  gitlabOfferedMergeRequestWritesV1,
  projectGitlabWriteOutcomeV1,
  type GitlabMergeRequestWriteIdV1,
  type GitlabWriteEffectV1,
  type GitlabWriteOutcomeV1,
} from './mutations.js';

/**
 * The three write payloads, as one union. Each is already parsed by its own
 * contract schema, so this names what may be dispatched without widening it to
 * an untyped bag.
 */
type GitlabWriteInputV1 =
  | GitlabMergeRequestMergeInputV1
  | GitlabMergeRequestMarkReadyInputV1
  | GitlabMergeRequestCloseInputV1;

const ACTION_BY_WRITE = Object.freeze({
  merge: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge,
  }),
  markReady: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady,
  }),
  close: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose,
  }),
});

/** What one settled write is presented as. */
type SettledWriteV1 = Readonly<{ tone: TextTone; title: string; detail?: string }>;

function describeRefusal(
  reason: string,
  dispatched: boolean,
  text: PluginTranslate,
): string {
  switch (reason) {
    case 'headAdvanced':
      return text(
        'plugins.gitlab.ui.mutations.refused.headAdvanced',
        'Nothing was written: new commits arrived after the ones you looked at.',
      );
    case 'notMergeable':
      return text(
        'plugins.gitlab.ui.mutations.refused.notMergeable',
        'GitLab will not merge this yet. Its checks, approvals or conflicts are still in the way.',
      );
    case 'mergeAttemptFailed':
      // GitLab's 422. The merge RAN. Retrying is not the advice.
      return text(
        'plugins.gitlab.ui.mutations.refused.mergeAttemptFailed',
        'GitLab tried to merge and the merge itself failed. Open it on GitLab before trying again.',
      );
    case 'shaRequired':
      return text(
        'plugins.gitlab.ui.mutations.refused.shaRequired',
        'GitLab required the commit this merge was pinned to and did not receive it.',
      );
    case 'mutationRejected':
      return text(
        'plugins.gitlab.ui.mutations.refused.mutationRejected',
        'GitLab rejected this change and performed none of it.',
      );
    default:
      return dispatched
        ? text(
          'plugins.gitlab.ui.mutations.refused.notOpen',
          'Nothing was written: GitLab reports this merge request is no longer open.',
        )
        : text(
          'plugins.gitlab.ui.mutations.refused.notOpenLocal',
          'Nothing was written: this merge request is no longer open.',
        );
  }
}

function describeApplied(
  effect: GitlabWriteEffectV1,
  text: PluginTranslate,
): SettledWriteV1 {
  switch (effect) {
    case 'merged':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.merge.merged',
          'Merged. GitLab confirmed this merge request is merged.',
        ),
      };
    case 'scheduled':
      // Deliberately NOT success. Nothing has merged yet.
      return {
        tone: 'warning',
        title: text(
          'plugins.gitlab.ui.mutations.merge.scheduled',
          'GitLab accepted this and will merge it later — it is queued, not merged.',
        ),
      };
    case 'ready':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.markReady.ready',
          'Ready for review. GitLab cleared the draft flag and notified the reviewers.',
        ),
      };
    default:
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.close.closed',
          'Closed. GitLab confirmed this merge request is closed.',
        ),
      };
  }
}

function projectSettledWrite(
  outcome: GitlabWriteOutcomeV1 | null,
  text: PluginTranslate,
): SettledWriteV1 | null {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case 'applied':
      return describeApplied(outcome.effect, text);
    case 'reconfirmationRequired':
      return {
        tone: 'warning',
        title: text(
          'plugins.gitlab.ui.mutations.reconfirm',
          'Nothing was written: this merge request changed after you read it. Reload and decide again.',
        ),
      };
    case 'refused':
      return { tone: 'warning', title: describeRefusal(outcome.reason, outcome.dispatched, text) };
    case 'unconfirmed': {
      // The request reached GitLab and its effect is unproven. This must never
      // read as "nothing happened", and never as a simple retry.
      const title = text(
        'plugins.gitlab.ui.mutations.unconfirmed',
        'GitLab received this and could not confirm the result. Reload before trying again — it may already have taken effect.',
      );
      return {
        tone: 'warning',
        title,
        ...(outcome.failure === undefined
          ? {}
          : { detail: describeTriageSourceFailureV1(outcome.failure, title) }),
      };
    }
    case 'unavailable': {
      const title = text(
        'plugins.gitlab.ui.mutations.unavailable',
        'Nothing was attempted. GitLab could not be reached or would not allow this.',
      );
      return { tone: 'danger', title, detail: describeTriageSourceFailureV1(outcome.failure, title) };
    }
    case 'declined':
      return {
        tone: 'neutral',
        title: text(
          'plugins.gitlab.ui.mutations.declined',
          'You declined the confirmation, so nothing was written.',
        ),
      };
    case 'uncertain':
      return {
        tone: 'warning',
        title: text(
          'plugins.gitlab.ui.mutations.outcomeUnknown',
          'The outcome is unknown. Reload this merge request before trying again.',
        ),
      };
    case 'rejected':
      return {
        tone: 'danger',
        title: text(
          'plugins.gitlab.ui.mutations.rejected',
          'This did not complete. Reload this merge request to see where it stands.',
        ),
      };
    default:
      return {
        tone: 'danger',
        title: text(
          'plugins.gitlab.ui.mutations.unreadable',
          'This build could not read what GitLab answered.',
        ),
      };
  }
}

function SettledWriteBanner({
  settled,
}: Readonly<{ settled: SettledWriteV1 | null }>): React.ReactElement | null {
  if (settled === null) return null;
  return (
    <Banner
      tone={settled.tone}
      title={settled.title}
      {...(settled.detail === undefined ? {} : { description: settled.detail })}
    />
  );
}

/**
 * One write control: a button, and the fact its last press settled on.
 *
 * It takes a payload that already exists. A write whose input cannot be built is
 * not mounted as a dead button here — the panel withholds it and says why —
 * because a control that is present and can never work reads as a permission
 * problem, which is a different fact from a head GitLab has not reported yet.
 * Each write is its own component, so mounting one conditionally changes no other
 * control's hook order.
 */
function GitlabWriteControl({
  write,
  input,
  label,
  labelKey,
  variant,
}: Readonly<{
  write: GitlabMergeRequestWriteIdV1;
  input: GitlabWriteInputV1;
  label: string;
  labelKey: string;
  variant: 'primary' | 'secondary';
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useExecutePluginAction(ACTION_BY_WRITE[write]);
  const run = React.useCallback(() => {
    void controller.execute(input);
  }, [controller, input]);

  const settled = projectSettledWrite(
    projectGitlabWriteOutcomeV1(write, controller.execution),
    text,
  );

  return (
    <Stack gap="small">
      <Row gap="small">
        <Button
          title={label}
          titleKey={labelKey}
          variant={variant}
          busy={controller.execution.status === 'pending'}
          onPress={run}
        />
      </Row>
      <SettledWriteBanner settled={settled} />
    </Stack>
  );
}

/**
 * The GitLab write controls for one mounted merge request.
 *
 * They exist only while the entry is an OPEN merge request, because all three
 * Actions transition an open merge request and GitLab refuses every one of them
 * on any other state. An issue, or a merge request already merged or closed, is
 * offered no control rather than one that could only be refused.
 */
export function GitlabMutationControls({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement | null {
  const text = usePluginTranslation();
  const offered = gitlabOfferedMergeRequestWritesV1({
    kindId: input.observation.entryRef.kindId,
    state: input.observation.snapshot.state,
  });

  // Each payload is built by the write contract's own schema, so a payload this
  // panel cannot legally form becomes an absent control rather than a button
  // whose every press is rejected at the daemon. The two head-pinned writes are
  // therefore absent exactly when the observation carries no head commit; close
  // needs none and is unaffected.
  const mergeInput = buildGitlabMergeRequestMergeInputV1(input);
  const markReadyInput = buildGitlabMergeRequestMarkReadyInputV1(input);
  const closeInput = buildGitlabMergeRequestCloseInputV1(input);

  if (offered.length === 0) return null;
  // A withheld head-pinned write is announced rather than silently missing: a
  // reader who cannot see Merge is owed the reason, and "GitLab has not reported
  // this merge request's head yet" is a different fact from "you may not merge".
  const headPinUnavailable = mergeInput === null || markReadyInput === null;

  return (
    <Stack gap="large">
      <Text
        variant="label"
        valueKey="plugins.gitlab.ui.mutations.title"
        fallback="Merge request actions"
      />
      <Stack gap="small">
        {mergeInput === null ? null : (
          <GitlabWriteControl
            write="merge"
            input={mergeInput}
            label={text('plugins.gitlab.ui.mutations.merge.button', 'Merge')}
            labelKey="plugins.gitlab.ui.mutations.merge.button"
            variant="primary"
          />
        )}
        {markReadyInput === null ? null : (
          <GitlabWriteControl
            write="markReady"
            input={markReadyInput}
            label={text('plugins.gitlab.ui.mutations.markReady.button', 'Mark ready for review')}
            labelKey="plugins.gitlab.ui.mutations.markReady.button"
            variant="secondary"
          />
        )}
        {closeInput === null ? null : (
          <GitlabWriteControl
            write="close"
            input={closeInput}
            label={text('plugins.gitlab.ui.mutations.close.button', 'Close')}
            labelKey="plugins.gitlab.ui.mutations.close.button"
            variant="secondary"
          />
        )}
        {closeInput === null ? null : (
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.gitlab.ui.mutations.close.description"
            fallback="A closed merge request stays on GitLab and can be reopened there."
          />
        )}
        {headPinUnavailable ? (
          <Text
            variant="caption"
            tone="warning"
            valueKey="plugins.gitlab.ui.mutations.pinUnavailable"
            fallback="GitLab has not reported this merge request’s latest commit, so it cannot be merged or marked ready from here yet."
          />
        ) : null}
      </Stack>
    </Stack>
  );
}
