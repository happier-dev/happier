import * as React from 'react';
import { type ReactElement } from 'react';
import {
  LoadingState,
  Button,
  Select,
  Stack,
  Text,
  TextField,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { readForgeOperationStateV1 } from '../operationState.js';
import { useForgeCiRunWorkflowV1, type ForgeCiRunWorkflowControllerV1 } from '../useForgeCiRunWorkflow.js';
import type { ForgeCiBindingV1 } from './binding.js';
import { ForgeCiStateNotice } from './ForgeCiStateNotice.js';
import { ForgeCiTriggerFields } from './ForgeCiTriggerFields.js';

export type ForgeCiRunWorkflowFormProps = Readonly<{
  ci: ForgeCiBindingV1;
  repository: ScmHostingRepositoryIdentityV1;
  workflowId: string;
  /** The ref the form opens on (the Project's branch, else the default branch). */
  initialRef: string;
  /** Branches and tags to pick from, when the host knows them; otherwise the ref is typed. */
  refs?: readonly string[];
  /** The forge returned the exact run it started: open it. Never called for a guessed run. */
  onStarted: (runId: string) => void;
  onCancel?: () => void;
  testID?: string;
  /** A selected-workflow detail and its form share the same controller. */
  controller?: ForgeCiRunWorkflowControllerV1;
  /** False keeps the ref readable without opening fields or consuming environment choices. */
  open?: boolean;
}>;

/**
 * The run form (lab a3 sheet body, D-21): pick the ref, review that ref's workflow inputs through the canonical
 * Form, and send one dispatch. Values the person set survive a ref change by native name; inputs that moved say so
 * before anything is sent. The forge's answer decides what happens next: an exact returned run opens, an accepted
 * dispatch without a run says so, and a lost answer is unknown — never retried, never matched to a run by time.
 */
export function ForgeCiRunWorkflowForm(props: ForgeCiRunWorkflowFormProps): ReactElement {
  return props.controller
    ? <RunWorkflowFormBody {...props} controller={props.controller} />
    : <UnboundRunWorkflowForm {...props} />;
}

function UnboundRunWorkflowForm(props: ForgeCiRunWorkflowFormProps): ReactElement {
  const controller = useForgeCiRunWorkflowV1({ ...props, formOpen: props.open !== false });
  return <RunWorkflowFormBody {...props} controller={controller} />;
}

function RunWorkflowFormBody({
  ci,
  refs,
  onCancel,
  testID,
  controller,
  open,
}: ForgeCiRunWorkflowFormProps & Readonly<{ controller: ForgeCiRunWorkflowControllerV1 }>): ReactElement {
  const t = usePluginTranslation();
  const { ref, setRef, draft, setDraft, current, status, environmentsQuery, environmentsStatus, sending, receipt, result, run } = controller;
  const about = {
    ...ci.about,
    subject: t('forgeCi.subject.workflow', 'this workflow'),
  };
  const readStatus = status.snapshot?.failure ? status : environmentsStatus;

  const refPicker =
    refs && refs.length > 0 ? (
      <Select
        label={t('forgeCi.trigger.ref', 'Use workflow from')}
        presentation="menu"
        value={ref}
        options={refs.map((value) => ({ value, label: value }))}
        onChange={(value) => {
          if (typeof value === 'string') setRef(value);
        }}
      />
    ) : (
      <TextField
        label={t('forgeCi.trigger.ref', 'Use workflow from')}
        value={ref}
        onChange={setRef}
        placeholder={t('forgeCi.trigger.refPlaceholder', 'Branch or tag')}
      />
    );
  const cancel = onCancel === undefined ? null : (
    <Button variant="secondary" title={t('happier.plugin-ui.form.cancel', 'Cancel')} onPress={onCancel} />
  );
  const notice =
    result && result.kind !== 'confirmed' ? (
      result.kind === 'accepted' ? (
        <Text
          variant="body"
          tone="secondary"
          value={t(
            'forgeCi.trigger.accepted',
            '{forge} accepted the run on {ref}. It appears in the runs list when {forge} starts it.',
            { forge: ci.about.forgeName, ref: receipt?.input.ref ?? ref.trim() },
          )}
        />
      ) : (
        <ForgeCiStateNotice
          presentation="banner"
          about={about}
          state={readForgeOperationStateV1({
            mutation: result,
            account: ci.account,
            hasRetainedValue: true,
          })}
        />
      )
    ) : readStatus.snapshot?.failure ? (
      <ForgeCiStateNotice
        presentation="banner"
        about={about}
        onRetry={readStatus.refresh}
        state={readForgeOperationStateV1({
          failure: readStatus.snapshot.failure,
          account: ci.account,
          hasRetainedValue: draft !== null,
        })}
      />
    ) : null;

  if (open === false) return <Stack gap="medium">{refPicker}{notice}</Stack>;

  if (draft === null) {
    return (
      <Stack gap="medium" {...(testID === undefined ? {} : { testID })}>
        {refPicker}
        {notice ?? (
          <LoadingState
            title={t(
              'forgeCi.trigger.loading',
              'Reading this workflow’s inputs',
            )}
            rows={3}
            layout="line"
          />
        )}
        {cancel}
      </Stack>
    );
  }
  return (
    <Stack gap="medium">
      <ForgeCiTriggerFields
      draft={draft}
      onDraftChange={setDraft}
      refPicker={refPicker}
      onRun={run}
      busy={sending}
      disabled={ci.adapter === null || current === null}
      notice={notice}
      {...(onCancel === undefined ? {} : { onCancel })}
      {...(testID === undefined ? {} : { testID })}
    />
      {environmentsQuery?.getValue()?.continuation ? (
        <Button variant="secondary" title={t('forgeCi.trigger.moreEnvironments', 'Load more environments')}
          busy={environmentsStatus.snapshot?.pending === true} onPress={() => environmentsQuery.loadMore()} />
      ) : null}
      {draft.projection.definition.dispatchable ? null : cancel}
    </Stack>
  );
}
