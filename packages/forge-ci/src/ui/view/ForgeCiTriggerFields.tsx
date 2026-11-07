import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  Banner,
  Form,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { ForgeCiTriggerValuesV1 } from '@happier-dev/triage-protocol/ci/v1';
import {
  readForgeCiTriggerValuesV1,
  updateForgeCiTriggerDraftV1,
  type ForgeCiTriggerDraftV1,
  type ForgeCiTriggerFieldIssueV1,
} from '../../runtime/triggerFields.js';

export type ForgeCiTriggerFieldsProps = Readonly<{
  draft: ForgeCiTriggerDraftV1;
  onDraftChange: (draft: ForgeCiTriggerDraftV1) => void;
  /** The branch or tag picker, owned by the host's ref source; the form follows the selected ref's definition. */
  refPicker?: ReactNode;
  /** Sends the exact current values once; the host owns approval and the receipt. */
  onRun: (values: ForgeCiTriggerValuesV1) => unknown;
  onCancel?: () => unknown;
  busy?: boolean;
  disabled?: boolean;
  /** The shared state notice (sign-in, unknown result) for this write, above the fields. */
  notice?: ReactNode;
  testID?: string;
}>;

function issueText(
  t: ReturnType<typeof usePluginTranslation>,
  issue: ForgeCiTriggerFieldIssueV1,
): string | null {
  switch (issue.reason) {
    case 'removed_field':
      return t(
        'forgeCi.trigger.removed',
        '“{name}” is no longer an input on this branch, so it won’t be sent.',
        { name: issue.name },
      );
    case 'changed_type':
      return t(
        'forgeCi.trigger.changedType',
        '“{name}” changed type on this branch. Check its value.',
        { name: issue.name },
      );
    case 'changed_options':
      return t(
        'forgeCi.trigger.changedOptions',
        '“{name}” has different choices on this branch. Pick one again.',
        { name: issue.name },
      );
    case 'options_empty':
      return t(
        'forgeCi.trigger.optionsEmpty',
        '“{name}” has no choices to pick from.',
        { name: issue.name },
      );
    case 'options_unavailable':
      return t(
        'forgeCi.trigger.optionsUnavailable',
        'The choices for “{name}” couldn’t be read.',
        { name: issue.name },
      );
    default:
      return null;
  }
}

/**
 * The run form's field set (lab a3): the ref picker, then the workflow's own inputs through the canonical Form,
 * which owns each field's presentation (text, switch, number, segmented or listed choices, environments). Values
 * the person has not touched stay unsent so the workflow's defaults apply; a changed definition says what moved
 * instead of submitting stale keys.
 */
export function ForgeCiTriggerFields({
  draft,
  onDraftChange,
  refPicker,
  onRun,
  onCancel,
  busy,
  disabled,
  notice,
  testID,
}: ForgeCiTriggerFieldsProps): ReactElement {
  const t = usePluginTranslation();
  const dispatchable = draft.projection.definition.dispatchable;
  const messages = [...draft.issues, ...draft.projection.unavailable]
    .map((issue) => issueText(t, issue))
    .filter((text): text is string => text !== null);
  const hints = draft.projection.formHints;
  return (
    <Stack gap="medium" {...(testID === undefined ? {} : { testID })}>
      {notice}
      {refPicker}
      {!dispatchable ? (
        <Text
          variant="body"
          tone="secondary"
          valueKey="forgeCi.trigger.notDispatchable"
          fallback="This workflow runs on its own events and can’t be started by hand on this branch."
        />
      ) : null}
      {messages.length > 0 ? (
        <Banner
          tone="attention"
          title={t('forgeCi.trigger.reviewTitle', 'Review before running')}
          points={messages.map((text) => [text])}
        />
      ) : null}
      {dispatchable ? (
        <Form
          hints={{
            ...hints,
            submitLabel:
              hints.submitLabel ?? t('forgeCi.trigger.run', 'Run workflow'),
          }}
          value={draft.input}
          onChange={(input) =>
            onDraftChange(updateForgeCiTriggerDraftV1(draft, input))
          }
          onSubmit={() => {
            const values = readForgeCiTriggerValuesV1(draft);
            if (values.kind === 'value') return onRun(values.value);
            return undefined;
          }}
          {...(onCancel === undefined ? {} : { onCancel })}
          busy={busy === true}
          submitDisabled={
            disabled === true ||
            readForgeCiTriggerValuesV1(draft).kind !== 'value'
          }
        />
      ) : null}
    </Stack>
  );
}
