import * as React from 'react';
import {
  Banner,
  Button,
  Divider,
  Form,
  Row,
  Stack,
  Text,
  useExecutePluginAction,
  usePluginTranslation,
  type PluginActionExecution,
  type PluginTranslate,
  type TextTone,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1 as failureDescription,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import {
  useTriagePostMutationCompletion,
  type TriagePostMutationCompletionV1,
} from '@happier-dev/triage-sources/ui';

import { AZURE_DEVOPS_PLUGIN_ID } from '../../azureDevopsContracts.js';
import { AZURE_ABANDONED_NATIVE_STATE_LABEL } from '../../triage/mapping.js';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from '../../triage/mutationActions.js';
import {
  AZURE_MAX_REQUESTED_REVIEWERS_V1,
  AZURE_REQUESTABLE_THREAD_STATUSES_V1,
  AzureMutationResultV1Schema,
  AzureThreadStatusResultV1Schema,
  type AzureRequestableThreadStatusV1,
} from '../../triage/mutations/contracts.js';
import type { AzureDetailOverviewV1 } from '../../triage/detail.js';
import type { AzureProjectedThreadRowV1 } from '../../triage/detail/projection.js';

import { useAzureEntryLocalRef } from './panelReaders.js';

/**
 * The two Azure DevOps pull-request writes, as controls a user can actually press.
 *
 * Both Actions declare `placementBindings: ['detailsPanel']`, and that declaration surfaces
 * nothing here: the only host consumer of an Action placement named `detailsPanel` is the browser
 * shell, over the separate `browserAction` contribution family. A Triage source's detail renderer
 * is a plugin artifact the host mounts whole, so an Action it does not render is an Action nobody
 * can reach. These controls are that rendering, and nothing more — the confirmation in front of
 * each write is host-owned manifest metadata, raised by the canonical Action gate before the
 * handler runs, so nothing here asks "are you sure".
 *
 * `transitionWorkItems` and `bypassPolicy` are deliberately absent as controls, exactly as they
 * are absent from the Action's input: moving somebody's Work Items and bypassing branch policy are
 * authorities pressing *Complete* does not grant, and the Action always sends both as `false`. The
 * branch decision IS offered, as a visible switch rather than a wire default, so the value the
 * request carries is one the user looked at.
 *
 * The merge-source pin is the exact commit this mount was handed — `observation.nativeRevision`,
 * which this source publishes from `lastMergeSourceCommit.commitId`. It is never re-read at press
 * time: that would be the race the pin exists to close.
 *
 * A write that settles is reported where it happened. `applied`, `pending`, `refused` and
 * `rejected` are four different facts and are never collapsed: Azure completion is asynchronous,
 * so an accepted completion is not a completed pull request, a refusal wrote nothing, and an
 * outcome the transport could not settle must not invite a blind retry.
 */

/** What one settled write is presented as. */
type SettledMutationV1 = Readonly<{
  tone: TextTone;
  title: string;
  detail?: string;
}>;

const COMPLETE_ACTION = Object.freeze({
  pluginId: AZURE_DEVOPS_PLUGIN_ID,
  localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.complete,
});
const ABANDON_ACTION = Object.freeze({
  pluginId: AZURE_DEVOPS_PLUGIN_ID,
  localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.abandon,
});
const REACTIVATE_ACTION = Object.freeze({
  pluginId: AZURE_DEVOPS_PLUGIN_ID,
  localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.reactivate,
});
const REQUEST_REVIEW_ACTION = Object.freeze({
  pluginId: AZURE_DEVOPS_PLUGIN_ID,
  localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview,
});
const THREAD_STATUS_ACTION = Object.freeze({
  pluginId: AZURE_DEVOPS_PLUGIN_ID,
  localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadStatus,
});

/**
 * The host code that proves the user was asked and said no.
 *
 * It settles before the Action handler is entered, so it is the one rejection this panel may
 * describe as having written nothing. Every other failure code is reported as an incomplete
 * write, because the generic transport cannot tell a refused dispatch from a handler that ran.
 */
const CURRENT_INTENT_REJECTED = 'plugin_action_current_intent_rejected';

/** The four pull-request-scoped writes this panel reports on. */
type AzureEntryMutationV1 = 'complete' | 'abandon' | 'reactivate' | 'requestReview';

/**
 * What a confirmed write says, in the words of the write that ran.
 *
 * Four operations settle into one result vocabulary, and one sentence for all four would tell a
 * reader *it worked* without saying what worked. The sentence names the effect Azure confirmed.
 */
function appliedTitle(operation: AzureEntryMutationV1, text: PluginTranslate): string {
  switch (operation) {
    case 'complete':
      return text(
        'plugins.azureDevops.ui.mutations.complete.applied',
        'Completed. Azure DevOps confirmed this pull request is completed.',
      );
    case 'abandon':
      return text(
        'plugins.azureDevops.ui.mutations.abandon.applied',
        'Abandoned. Azure DevOps confirmed this pull request is abandoned.',
      );
    case 'reactivate':
      return text(
        'plugins.azureDevops.ui.mutations.reactivate.applied',
        'Reactivated. Azure DevOps confirmed this pull request is active again.',
      );
    default:
      return text(
        'plugins.azureDevops.ui.mutations.requestReview.applied',
        'Requested. Azure DevOps lists everyone you chose as a reviewer.',
      );
  }
}

/** What an accepted-but-unconfirmed write says. Accepted is never reported as done. */
function pendingTitle(operation: AzureEntryMutationV1, text: PluginTranslate): string {
  switch (operation) {
    case 'complete':
      return text(
        'plugins.azureDevops.ui.mutations.complete.pending',
        'Azure DevOps accepted the completion but has not confirmed it yet.',
      );
    case 'abandon':
      return text(
        'plugins.azureDevops.ui.mutations.abandon.pending',
        'Azure DevOps accepted the abandon but has not confirmed it yet.',
      );
    case 'reactivate':
      return text(
        'plugins.azureDevops.ui.mutations.reactivate.pending',
        'Azure DevOps accepted the reactivation but has not confirmed it yet.',
      );
    default:
      return text(
        'plugins.azureDevops.ui.mutations.requestReview.pending',
        'Azure DevOps accepted the request but does not list them as reviewers yet.',
      );
  }
}

/**
 * Why nothing was written, in the words of the gate that refused.
 *
 * Every arm of the published refusal vocabulary has its own sentence. Folding the two state
 * refusals together would tell somebody looking at an abandoned pull request that it is *no longer
 * active*, which is the reason they pressed Reactivate.
 */
function refusedTitle(
  reason: 'head-advanced' | 'entry-not-active' | 'entry-not-abandoned' | 'reviewer-already-present',
  text: PluginTranslate,
): string {
  switch (reason) {
    case 'head-advanced':
      return text(
        'plugins.azureDevops.ui.mutations.refused.headAdvanced',
        'Nothing was written: new commits arrived after the ones you looked at.',
      );
    case 'entry-not-active':
      return text(
        'plugins.azureDevops.ui.mutations.refused.notActive',
        'Nothing was written: this pull request is no longer active.',
      );
    case 'entry-not-abandoned':
      return text(
        'plugins.azureDevops.ui.mutations.refused.notAbandoned',
        'Nothing was written: only an abandoned pull request can be reactivated.',
      );
    default:
      // Azure's additive reviewer route carries a vote for a reviewer it already knows, so re-adding
      // one is how an approval gets reset by a button that said *request review*.
      return text(
        'plugins.azureDevops.ui.mutations.refused.reviewerPresent',
        'Nothing was written: somebody you chose already reviews this pull request.',
      );
  }
}

/**
 * The facts that are true of every write before its own result is read.
 *
 * Every dispatch can end in the host's own refusal, an unknown outcome or a transport failure, and
 * those three sentences do not vary with the write that ran. The `result` arm carries the value the
 * handler published, so the caller reads it from here rather than re-narrowing the execution — one
 * owner for the envelope, so a second write surface cannot start describing a declined
 * confirmation as a provider failure.
 */
function projectExecutionEnvelope(
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null | Readonly<{ published: unknown }> {
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') {
    return {
      tone: 'warning',
      title: text(
        'plugins.azureDevops.ui.mutations.outcomeUnknown',
        'The outcome is unknown. Reload this pull request before trying again.',
      ),
    };
  }
  if (execution.status === 'error') {
    return execution.code === CURRENT_INTENT_REJECTED
      ? {
        tone: 'neutral',
        title: text(
          'plugins.azureDevops.ui.mutations.declined',
          'You declined the confirmation, so nothing was written.',
        ),
      }
      : {
        tone: 'danger',
        title: text(
          'plugins.azureDevops.ui.mutations.failed',
          'This did not complete. Reload this pull request to see where it stands.',
        ),
      };
  }
  return { published: execution.result };
}

/** Whether an envelope reached the handler's own published result. */
function isPublishedResult(
  envelope: SettledMutationV1 | null | Readonly<{ published: unknown }>,
): envelope is Readonly<{ published: unknown }> {
  return envelope !== null && 'published' in envelope;
}

/** What this build says when it cannot read the result its own Action published. */
function unreadableResult(text: PluginTranslate): SettledMutationV1 {
  return {
    tone: 'danger',
    title: text(
      'plugins.azureDevops.ui.mutations.unreadable',
      'This build could not read what Azure DevOps answered.',
    ),
  };
}

async function completeAfterEntryWrite(
  execution: PluginActionExecution<unknown>,
  complete: TriagePostMutationCompletionV1,
): Promise<void> {
  if (execution.status !== 'success') return;
  const parsed = AzureMutationResultV1Schema.safeParse(execution.result);
  if (parsed.success && (
    parsed.data.kind === 'applied'
    || parsed.data.kind === 'pending'
    || parsed.data.kind === 'uncertain'
  )) await complete();
}

async function completeAfterThreadWrite(
  execution: PluginActionExecution<unknown>,
  complete: TriagePostMutationCompletionV1,
): Promise<void> {
  if (execution.status !== 'success') return;
  const parsed = AzureThreadStatusResultV1Schema.safeParse(execution.result);
  if (parsed.success && (
    parsed.data.kind === 'applied'
    || parsed.data.kind === 'rejected'
    || parsed.data.kind === 'uncertain'
  )) await complete();
}

function projectSettledMutation(
  operation: AzureEntryMutationV1,
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null {
  const envelope = projectExecutionEnvelope(execution, text);
  if (!isPublishedResult(envelope)) return envelope;

  const parsed = AzureMutationResultV1Schema.safeParse(envelope.published);
  if (!parsed.success) return unreadableResult(text);
  const result = parsed.data;
  switch (result.kind) {
    case 'applied':
      return { tone: 'success', title: appliedTitle(operation, text) };
    case 'pending':
      if (operation !== 'complete') return { tone: 'warning', title: pendingTitle(operation, text) };
      // Auto-complete is not a poll that ran out of patience: completion fires later, on policy
      // satisfaction, outside this request entirely. Saying so is the honest answer indefinitely.
      return {
        tone: 'warning',
        title: result.autoCompleteEnabled === true
          ? text(
            'plugins.azureDevops.ui.mutations.complete.pendingAutoComplete',
            'Auto-complete is on, so Azure DevOps completes this pull request when its policies pass.',
          )
          : pendingTitle(operation, text),
      };
    case 'refused':
      return { tone: 'warning', title: refusedTitle(result.reason, text) };
    case 'rejected': {
      const title = result.reason === 'conflicts'
        ? text(
          'plugins.azureDevops.ui.mutations.rejected.conflicts',
          'Azure DevOps could not merge this pull request: it has conflicts.',
        )
        : result.reason === 'rejectedByPolicy'
          ? text(
            'plugins.azureDevops.ui.mutations.rejected.policy',
            'Azure DevOps refused the merge: a branch policy rejected it.',
          )
          : result.reason === 'failure'
            ? text(
              'plugins.azureDevops.ui.mutations.rejected.failure',
              'Azure DevOps reported that the merge failed.',
            )
            : text(
              'plugins.azureDevops.ui.mutations.rejected.fieldsIgnored',
              'Azure DevOps answered success but applied nothing.',
            );
      // Azure's own `mergeFailureMessage`, when it supplied one. Provider text, shown as provider
      // text rather than folded into this build's sentence.
      return { tone: 'danger', title, ...(result.detail === undefined ? {} : { detail: result.detail }) };
    }
    case 'uncertain':
      return {
        tone: 'warning',
        title: text(
          'plugins.azureDevops.ui.mutations.uncertain',
          'Azure DevOps may have applied this write. Reload the pull request before trying again.',
        ),
        ...(result.failure === undefined ? {} : {
          detail: failureDescription(result.failure, ''),
        }),
      };
    case 'unavailable': {
      const title = text(
        'plugins.azureDevops.ui.mutations.unavailable',
        'Azure DevOps could not complete this write.',
      );
      return { tone: 'danger', title, detail: failureDescription(result.failure, title) };
    }
  }
}

function SettledMutationBanner({
  settled,
}: Readonly<{ settled: SettledMutationV1 | null }>): React.ReactElement | null {
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
 * The identity ids one review request carries, exactly as the reader typed them.
 *
 * Azure identifies a reviewer by identity id, and this source declares no identity search — so the
 * field takes ids rather than names rather than guessing a name onto an identity, which is how the
 * wrong person gets added to somebody's pull request. Commas and whitespace both separate, and a
 * repeated id collapses: the Action's input rejects duplicates outright, while a person who pasted
 * the same id twice still means one person.
 */
export function readReviewerIds(value: string): readonly string[] {
  const ids = new Set<string>();
  for (const candidate of value.split(/[\s,]+/u)) {
    const trimmed = candidate.trim();
    if (trimmed !== '') ids.add(trimmed);
  }
  return Object.freeze([...ids]);
}

/**
 * The Azure DevOps write controls for one mounted pull request.
 *
 * Which controls exist follows what Azure will accept, so no control is offered that could only be
 * refused. An **active** pull request can be completed, abandoned, and have review requested on
 * it. An **abandoned** one has exactly one transition — reactivation — and a **completed** one has
 * none at all, which is why `closed` alone is not enough to decide: it covers both, and only the
 * native label separates them.
 */
export function AzureMutationControls({
  input,
  overview,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: AzureDetailOverviewV1;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const completeMutation = useTriagePostMutationCompletion();
  const localRef = useAzureEntryLocalRef(input);
  const complete = useExecutePluginAction(COMPLETE_ACTION);
  const abandon = useExecutePluginAction(ABANDON_ACTION);
  const reactivate = useExecutePluginAction(REACTIVATE_ACTION);
  const requestReview = useExecutePluginAction(REQUEST_REVIEW_ACTION);
  const [deleteSourceBranch, setDeleteSourceBranch] = React.useState(false);
  const [reviewerIdsValue, setReviewerIdsValue] = React.useState('');

  const observedSourceCommitId = overview.nativeRevision;
  const reviewerIds = React.useMemo(() => readReviewerIds(reviewerIdsValue), [reviewerIdsValue]);
  const tooManyReviewers = reviewerIds.length > AZURE_MAX_REQUESTED_REVIEWERS_V1;

  const runComplete = React.useCallback(() => {
    if (observedSourceCommitId === null) return;
    void complete.execute({
      v: 1,
      instance: input.instance,
      localRef,
      observedSourceCommitId,
      deleteSourceBranch,
    }).then(async (execution) => await completeAfterEntryWrite(execution, completeMutation));
  }, [complete, completeMutation, deleteSourceBranch, input.instance, localRef, observedSourceCommitId]);

  const runAbandon = React.useCallback(() => {
    void abandon.execute({ v: 1, instance: input.instance, localRef })
      .then(async (execution) => await completeAfterEntryWrite(execution, completeMutation));
  }, [abandon, completeMutation, input.instance, localRef]);

  const runReactivate = React.useCallback(() => {
    void reactivate.execute({ v: 1, instance: input.instance, localRef })
      .then(async (execution) => await completeAfterEntryWrite(execution, completeMutation));
  }, [completeMutation, input.instance, localRef, reactivate]);

  const runRequestReview = React.useCallback(() => {
    const ids = readReviewerIds(reviewerIdsValue);
    if (observedSourceCommitId === null) return;
    if (ids.length === 0 || ids.length > AZURE_MAX_REQUESTED_REVIEWERS_V1) return;
    void requestReview.execute({
      v: 1,
      instance: input.instance,
      localRef,
      observedSourceCommitId,
      reviewerIds: ids,
    }).then(async (execution) => await completeAfterEntryWrite(execution, completeMutation));
  }, [completeMutation, input.instance, localRef, observedSourceCommitId, requestReview, reviewerIdsValue]);

  if (overview.state.presentation !== 'active') {
    // Azure's reopen, and the only transition a non-active pull request has. `closed` covers
    // completed AND abandoned, and offering Reactivate on a completed one would be offering to
    // undo a merge that already landed — so the native label decides, from the one exported
    // constant the mapper writes it with.
    if (overview.state.nativeLabel !== AZURE_ABANDONED_NATIVE_STATE_LABEL) return null;
    return (
      <Stack gap="large">
        <Divider />
        <Text
          variant="label"
          valueKey="plugins.azureDevops.ui.mutations.title"
          fallback="Pull request actions"
        />
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.azureDevops.ui.mutations.reactivate.description"
            fallback="This pull request is abandoned. Reactivating makes it active again and asks its reviewers again."
          />
          <Row gap="small">
            <Button
              title={text('plugins.azureDevops.ui.mutations.reactivate.button', 'Reactivate')}
              titleKey="plugins.azureDevops.ui.mutations.reactivate.button"
              variant="primary"
              busy={reactivate.execution.status === 'pending'}
              onPress={runReactivate}
            />
          </Row>
          <SettledMutationBanner
            settled={projectSettledMutation('reactivate', reactivate.execution, text)}
          />
        </Stack>
      </Stack>
    );
  }

  const completeSettled = projectSettledMutation('complete', complete.execution, text);
  const abandonSettled = projectSettledMutation('abandon', abandon.execution, text);
  const requestReviewSettled = projectSettledMutation(
    'requestReview',
    requestReview.execution,
    text,
  );

  return (
    <Stack gap="large">
      <Divider />
      <Text
        variant="label"
        valueKey="plugins.azureDevops.ui.mutations.title"
        fallback="Pull request actions"
      />
      <Stack gap="small">
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.azureDevops.ui.mutations.complete.description"
          fallback="Work items are not transitioned and branch policy is not bypassed."
        />
        <Form.Toggle
          label={text(
            'plugins.azureDevops.ui.mutations.complete.deleteSourceBranch',
            'Delete the source branch after completing',
          )}
          value={deleteSourceBranch}
          onChange={setDeleteSourceBranch}
        />
        {observedSourceCommitId !== null ? null : (
          <Text
            variant="caption"
            tone="warning"
            valueKey="plugins.azureDevops.ui.mutations.complete.sourceUnavailable"
            fallback="Azure DevOps did not report the merge source commit of this pull request, so it cannot be completed from here."
          />
        )}
        <Row gap="small">
          <Button
            title={text('plugins.azureDevops.ui.mutations.complete.button', 'Complete')}
            titleKey="plugins.azureDevops.ui.mutations.complete.button"
            variant="primary"
            disabled={observedSourceCommitId === null}
            busy={complete.execution.status === 'pending'}
            onPress={runComplete}
          />
        </Row>
        <SettledMutationBanner settled={completeSettled} />
      </Stack>
      <Stack gap="small">
        <Form.TextField
          label={text(
            'plugins.azureDevops.ui.mutations.requestReview.identities',
            'Reviewer identity IDs',
          )}
          labelKey="plugins.azureDevops.ui.mutations.requestReview.identities"
          placeholder={text(
            'plugins.azureDevops.ui.mutations.requestReview.identitiesPlaceholder',
            'Separate several with commas',
          )}
          placeholderKey="plugins.azureDevops.ui.mutations.requestReview.identitiesPlaceholder"
          value={reviewerIdsValue}
          onChange={setReviewerIdsValue}
        />
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.azureDevops.ui.mutations.requestReview.description"
          fallback="Everyone you name is added as a reviewer. Nobody currently reviewing is removed, and no existing vote is changed."
        />
        {!tooManyReviewers ? null : (
          <Text
            variant="caption"
            tone="warning"
            valueKey="plugins.azureDevops.ui.mutations.requestReview.tooMany"
            fallback="One request carries at most {max} reviewers."
            values={{ max: AZURE_MAX_REQUESTED_REVIEWERS_V1 }}
          />
        )}
        <Row gap="small">
          <Button
            title={text('plugins.azureDevops.ui.mutations.requestReview.button', 'Request review')}
            titleKey="plugins.azureDevops.ui.mutations.requestReview.button"
            variant="secondary"
            disabled={
              reviewerIds.length === 0 || tooManyReviewers || observedSourceCommitId === null
            }
            busy={requestReview.execution.status === 'pending'}
            onPress={runRequestReview}
          />
        </Row>
        <SettledMutationBanner settled={requestReviewSettled} />
      </Stack>
      <Stack gap="small">
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.azureDevops.ui.mutations.abandon.description"
          fallback="Azure DevOps can reactivate an abandoned pull request later."
        />
        <Row gap="small">
          <Button
            title={text('plugins.azureDevops.ui.mutations.abandon.button', 'Abandon')}
            titleKey="plugins.azureDevops.ui.mutations.abandon.button"
            variant="secondary"
            busy={abandon.execution.status === 'pending'}
            onPress={runAbandon}
          />
        </Row>
        <SettledMutationBanner settled={abandonSettled} />
      </Stack>
    </Stack>
  );
}

/* ------------------------------------------------------------- thread status */

/**
 * Azure's own thread-status names, as words a reader recognizes.
 *
 * `unknown` is deliberately absent: it is what Azure reports for a thread nobody has given a
 * status, not an intent anybody expresses, and offering it would let a reader "set" a thread to
 * *we do not know*.
 */
function threadStatusLabel(
  status: AzureRequestableThreadStatusV1,
  text: PluginTranslate,
): string {
  switch (status) {
    case 'active':
      return text('plugins.azureDevops.ui.mutations.threadStatus.active', 'Active');
    case 'fixed':
      return text('plugins.azureDevops.ui.mutations.threadStatus.fixed', 'Fixed');
    case 'wontFix':
      return text('plugins.azureDevops.ui.mutations.threadStatus.wontFix', "Won't fix");
    case 'closed':
      return text('plugins.azureDevops.ui.mutations.threadStatus.closed', 'Closed');
    case 'byDesign':
      return text('plugins.azureDevops.ui.mutations.threadStatus.byDesign', 'By design');
    default:
      return text('plugins.azureDevops.ui.mutations.threadStatus.pending', 'Pending');
  }
}

/**
 * What one thread-status write settled into.
 *
 * It reads a different published vocabulary from the four pull-request writes, because what
 * changed is the thread rather than the entry — but the execution envelope in front of it is the
 * same one, read from the same owner.
 */
function projectSettledThreadStatus(
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null {
  const envelope = projectExecutionEnvelope(execution, text);
  if (!isPublishedResult(envelope)) return envelope;

  const parsed = AzureThreadStatusResultV1Schema.safeParse(envelope.published);
  if (!parsed.success) return unreadableResult(text);
  const result = parsed.data;
  switch (result.kind) {
    case 'applied':
      return {
        tone: 'success',
        title: text(
          'plugins.azureDevops.ui.mutations.threadStatus.applied',
          'Azure DevOps confirmed this thread is now {status}.',
          { status: result.status },
        ),
      };
    case 'refused':
      return {
        tone: 'neutral',
        title: text(
          'plugins.azureDevops.ui.mutations.threadStatus.alreadyInStatus',
          'Nothing was written: this thread already carries that status.',
        ),
      };
    case 'rejected':
      // Azure answered success and the confirming read still shows something else. That is a
      // silently ignored property, and it is reported rather than presented as done.
      return {
        tone: 'danger',
        title: text(
          'plugins.azureDevops.ui.mutations.threadStatus.fieldsIgnored',
          'Azure DevOps answered success but this thread still reads {status}.',
          { status: result.status },
        ),
      };
    case 'uncertain':
      return {
        tone: 'warning',
        title: text(
          'plugins.azureDevops.ui.mutations.threadStatus.uncertain',
          'Azure DevOps may have changed this thread. Reload it before trying again.',
        ),
        ...(result.failure === undefined ? {} : {
          detail: failureDescription(result.failure, ''),
        }),
      };
    case 'unavailable': {
      const title = text(
        'plugins.azureDevops.ui.mutations.unavailable',
        'Azure DevOps could not complete this write.',
      );
      return { tone: 'danger', title, detail: failureDescription(result.failure, title) };
    }
  }
}

/**
 * The status control for exactly one review thread.
 *
 * It carries the thread id the Threads projection published and nothing else about the
 * conversation: this write says one thing about one thread, and the Action's body sends `status`
 * alone so a status change cannot quietly rewrite the discussion it was about.
 *
 * The settled answer is the THREAD's own re-read status rather than the pull request's, because
 * the thread is what changed.
 */
export function AzureThreadStatusControl({
  input,
  thread,
  onClose,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  thread: AzureProjectedThreadRowV1;
  onClose: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const completeMutation = useTriagePostMutationCompletion();
  const localRef = useAzureEntryLocalRef(input);
  const threadStatus = useExecutePluginAction(THREAD_STATUS_ACTION);
  const [status, setStatus] = React.useState<AzureRequestableThreadStatusV1 | null>(null);

  const run = React.useCallback(() => {
    if (status === null) return;
    void threadStatus.execute({
      v: 1,
      instance: input.instance,
      localRef,
      threadId: thread.id,
      status,
    }).then(async (execution) => await completeAfterThreadWrite(execution, completeMutation));
  }, [completeMutation, input.instance, localRef, status, thread.id, threadStatus]);

  return (
    <Stack gap="small">
      <Text
        variant="label"
        value={text(
          'plugins.azureDevops.ui.mutations.threadStatus.title',
          'Status of thread {thread}',
          { thread: thread.id },
        )}
      />
      <Form.Select
        label={text('plugins.azureDevops.ui.mutations.threadStatus.label', 'Thread status')}
        options={AZURE_REQUESTABLE_THREAD_STATUSES_V1.map((candidate) => ({
          value: candidate,
          label: threadStatusLabel(candidate, text),
        }))}
        {...(status === null ? {} : { value: status })}
        onChange={(next) => {
          // Only Azure's own requestable names are selectable, so anything else selects nothing
          // rather than becoming a status by assertion.
          const chosen = AZURE_REQUESTABLE_THREAD_STATUSES_V1
            .find((candidate) => candidate === next);
          if (chosen !== undefined) setStatus(chosen);
        }}
      />
      <Row gap="small">
        <Button
          title={text('plugins.azureDevops.ui.mutations.threadStatus.button', 'Set status')}
          titleKey="plugins.azureDevops.ui.mutations.threadStatus.button"
          variant="primary"
          disabled={status === null}
          busy={threadStatus.execution.status === 'pending'}
          onPress={run}
        />
        <Button
          title={text('plugins.azureDevops.ui.mutations.threadStatus.close', 'Close')}
          titleKey="plugins.azureDevops.ui.mutations.threadStatus.close"
          variant="plain"
          onPress={onClose}
        />
      </Row>
      <SettledMutationBanner settled={projectSettledThreadStatus(threadStatus.execution, text)} />
    </Stack>
  );
}
