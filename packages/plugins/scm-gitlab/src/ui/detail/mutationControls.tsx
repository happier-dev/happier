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
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  Banner,
  Button,
  Row,
  Stack,
  Text,
  TextField,
  useExecutePluginAction,
  usePluginTranslation,
  type PluginTranslate,
  type TextTone,
} from '@happier-dev/plugin-ui';
import {
  completeTriagePostMutationIfNeeded,
  useTriagePostMutationCompletion,
} from '@happier-dev/triage-sources/ui';
import {
  describeTriageSourceFailureV1,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../triage/contribution.js';
import {
  buildGitlabMergeRequestCloseInputV1,
  buildGitlabMergeRequestMarkReadyInputV1,
  buildGitlabMergeRequestMergeInputV1,
  buildGitlabMergeRequestReopenInputV1,
  buildGitlabReviewerChangeInputV1,
  buildGitlabDiscussionResolutionInputV1,
  buildGitlabIssueCloseInputV1,
  buildGitlabIssueReopenInputV1,
  buildGitlabIssueAssignInputV1,
  buildGitlabIssueLabelInputV1,
  gitlabOfferedIssueWritesV1,
  gitlabOfferedMergeRequestWritesV1,
  gitlabWriteMayHaveChangedProviderStateV1,
  projectGitlabWriteOutcomeV1,
  type GitlabWriteIdV1,
  type GitlabWriteEffectV1,
  type GitlabWriteOutcomeV1,
} from './mutations.js';

/**
 * The three write payloads, as one union. Each is already parsed by its own
 * contract schema, so this names what may be dispatched without widening it to
 * an untyped bag.
 */
type GitlabWriteInputV1 = JsonValue;

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
  mergeRequestReopen: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReopen,
  }),
  reviewerChange: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewerChange,
  }),
  discussionResolution: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestDiscussionResolution,
  }),
  issueClose: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueClose,
  }),
  issueReopen: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueReopen,
  }),
  issueAssign: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueAssign,
  }),
  issueLabel: Object.freeze({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueLabel,
  }),
});

/** What one settled write is presented as. */
type SettledWriteV1 = Readonly<{ tone: TextTone; title: string; detail?: string }>;

function describeRefusal(
  reason: string,
  dispatched: boolean,
  text: PluginTranslate,
  issueWrite: boolean,
): string {
  if (issueWrite) {
    return dispatched
      ? 'GitLab rejected this issue change after it was dispatched.'
      : 'Nothing was written: GitLab reports this issue cannot accept that change.';
  }
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
  issueWrite: boolean,
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
    case 'reopened':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.reopen.reopened',
          'Reopened. GitLab confirmed this entry is open.',
        ),
      };
    case 'reviewersChanged':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.reviewers.updated',
          'Reviewers updated. GitLab confirmed the new reviewer set.',
        ),
      };
    case 'discussionStateChanged':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.discussion.updated',
          'Discussion updated. GitLab confirmed its resolution state.',
        ),
      };
    case 'assigneesChanged':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.assignees.updated',
          'Assignees updated. GitLab confirmed the new assignee set.',
        ),
      };
    case 'labelsChanged':
      return {
        tone: 'success',
        title: text(
          'plugins.gitlab.ui.mutations.labels.updated',
          'Labels updated. GitLab confirmed the new label set.',
        ),
      };
    default:
      if (issueWrite) {
        return {
          tone: 'success',
          title: text(
            'plugins.gitlab.ui.mutations.issue.closed',
            'Closed. GitLab confirmed this issue is closed.',
          ),
        };
      }
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
  write: GitlabWriteIdV1,
  outcome: GitlabWriteOutcomeV1 | null,
  text: PluginTranslate,
): SettledWriteV1 | null {
  if (outcome === null) return null;
  const issueWrite = write === 'issueClose' || write === 'issueReopen'
    || write === 'issueAssign' || write === 'issueLabel';
  switch (outcome.kind) {
    case 'applied':
      return describeApplied(outcome.effect, text, issueWrite);
    case 'reconfirmationRequired':
      return {
        tone: 'warning',
        title: issueWrite
          ? 'Nothing was written: this issue changed after you read it. Reload and decide again.'
          : text(
            'plugins.gitlab.ui.mutations.reconfirm',
            'Nothing was written: this merge request changed after you read it. Reload and decide again.',
          ),
      };
    case 'refused':
      return { tone: 'warning', title: describeRefusal(outcome.reason, outcome.dispatched, text, issueWrite) };
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
        title: issueWrite
          ? 'The outcome is unknown. Reload this issue before trying again.'
          : text(
            'plugins.gitlab.ui.mutations.outcomeUnknown',
            'The outcome is unknown. Reload this merge request before trying again.',
          ),
      };
    case 'rejected':
      return {
        tone: 'danger',
        title: issueWrite
          ? 'This did not complete. Reload this issue to see where it stands.'
          : text(
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
  write: GitlabWriteIdV1;
  input: GitlabWriteInputV1 | null;
  label: string;
  labelKey?: string;
  variant: 'primary' | 'secondary';
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useExecutePluginAction(ACTION_BY_WRITE[write]);
  const completePostMutation = useTriagePostMutationCompletion();
  const run = React.useCallback(() => {
    if (input === null) return;
    void (async () => {
      const execution = await controller.execute(input);
      await completeTriagePostMutationIfNeeded(
        completePostMutation,
        execution,
        (settled) => gitlabWriteMayHaveChangedProviderStateV1(
          projectGitlabWriteOutcomeV1(write, settled),
        ),
      );
    })();
  }, [completePostMutation, controller, input, write]);

  const settled = projectSettledWrite(
    write,
    projectGitlabWriteOutcomeV1(write, controller.execution),
    text,
  );

  return (
    <Stack gap="small">
      <Row gap="small">
        <Button
          title={label}
          {...(labelKey === undefined ? {} : { titleKey: labelKey })}
          variant={variant}
          busy={controller.execution.status === 'pending'}
          disabled={input === null}
          onPress={run}
        />
      </Row>
      <SettledWriteBanner settled={settled} />
    </Stack>
  );
}

function parseNames(value: string): readonly string[] {
  const name = value.trim();
  return name === '' ? [] : [name];
}

function NamedDeltaControls({ input, kind }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kind: 'reviewers' | 'assignees' | 'labels';
}>): React.ReactElement {
  const [value, setValue] = React.useState('');
  const names = parseNames(value);
  const build = (operation: 'add' | 'remove') => kind === 'reviewers'
    ? buildGitlabReviewerChangeInputV1(input, operation, names)
    : kind === 'assignees'
      ? buildGitlabIssueAssignInputV1(input, operation, names)
      : buildGitlabIssueLabelInputV1(input, operation, names);
  const write: GitlabWriteIdV1 = kind === 'reviewers'
    ? 'reviewerChange'
    : kind === 'assignees' ? 'issueAssign' : 'issueLabel';
  const fieldLabel = kind === 'reviewers'
    ? 'Reviewer username'
    : kind === 'assignees' ? 'Assignee username' : 'Label name';
  return (
    <Stack gap="small">
      <TextField label={fieldLabel} value={value} onChange={setValue} />
      <Row gap="small">
        {(['add', 'remove'] as const).map((operation) => {
          const built = build(operation);
          return (
            <GitlabWriteControl
              key={operation}
              write={write}
              input={built}
              label={`${operation === 'add' ? 'Add' : 'Remove'} ${kind}`}
              variant="secondary"
            />
          );
        })}
      </Row>
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
  const mergeRequestWrites = gitlabOfferedMergeRequestWritesV1({
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
  const reopenInput = buildGitlabMergeRequestReopenInputV1(input);
  const issueWrites = gitlabOfferedIssueWritesV1({
    kindId: input.observation.entryRef.kindId,
    state: input.observation.snapshot.state,
  });
  const issueCloseInput = buildGitlabIssueCloseInputV1(input);
  const issueReopenInput = buildGitlabIssueReopenInputV1(input);

  if (mergeRequestWrites.length === 0 && issueWrites.length === 0) return null;
  // A withheld head-pinned write is announced rather than silently missing: a
  // reader who cannot see Merge is owed the reason, and "GitLab has not reported
  // this merge request's head yet" is a different fact from "you may not merge".
  const headPinUnavailable = mergeRequestWrites.includes('merge')
    && (mergeInput === null || markReadyInput === null);

  return (
    <Stack gap="large">
      <Text variant="label">
        {input.observation.entryRef.kindId === 'issue'
          ? 'Issue actions'
          : text('plugins.gitlab.ui.mutations.title', 'Merge request actions')}
      </Text>
      <Stack gap="small">
        {!mergeRequestWrites.includes('merge') || mergeInput === null ? null : (
          <GitlabWriteControl
            write="merge"
            input={mergeInput}
            label={text('plugins.gitlab.ui.mutations.merge.button', 'Merge')}
            labelKey="plugins.gitlab.ui.mutations.merge.button"
            variant="primary"
          />
        )}
        {!mergeRequestWrites.includes('markReady') || markReadyInput === null ? null : (
          <GitlabWriteControl
            write="markReady"
            input={markReadyInput}
            label={text('plugins.gitlab.ui.mutations.markReady.button', 'Mark ready for review')}
            labelKey="plugins.gitlab.ui.mutations.markReady.button"
            variant="secondary"
          />
        )}
        {!mergeRequestWrites.includes('close') || closeInput === null ? null : (
          <GitlabWriteControl
            write="close"
            input={closeInput}
            label={text('plugins.gitlab.ui.mutations.close.button', 'Close')}
            labelKey="plugins.gitlab.ui.mutations.close.button"
            variant="secondary"
          />
        )}
        {!mergeRequestWrites.includes('mergeRequestReopen') || reopenInput === null ? null : (
          <GitlabWriteControl write="mergeRequestReopen" input={reopenInput} label="Reopen" labelKey="plugins.gitlab.ui.mutations.reopen.button" variant="secondary" />
        )}
        {!mergeRequestWrites.includes('reviewerChange') ? null : <NamedDeltaControls input={input} kind="reviewers" />}
        {!issueWrites.includes('issueClose') ? null : (
          <GitlabWriteControl write="issueClose" input={issueCloseInput} label="Close issue" labelKey="plugins.gitlab.ui.mutations.issue.close.button" variant="secondary" />
        )}
        {!issueWrites.includes('issueReopen') ? null : (
          <GitlabWriteControl write="issueReopen" input={issueReopenInput} label="Reopen issue" labelKey="plugins.gitlab.ui.mutations.issue.reopen.button" variant="secondary" />
        )}
        {!issueWrites.includes('issueAssign') ? null : <NamedDeltaControls input={input} kind="assignees" />}
        {!issueWrites.includes('issueLabel') ? null : <NamedDeltaControls input={input} kind="labels" />}
        {!mergeRequestWrites.includes('close') || closeInput === null ? null : (
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

export function GitlabDiscussionResolutionControl({ input, discussionId, resolved }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  discussionId: string;
  resolved: boolean;
}>): React.ReactElement | null {
  const built = buildGitlabDiscussionResolutionInputV1(input, discussionId, !resolved);
  return built === null ? null : (
    <GitlabWriteControl
      write="discussionResolution"
      input={built}
      label={resolved ? 'Reopen discussion' : 'Resolve discussion'}
      variant="secondary"
    />
  );
}
