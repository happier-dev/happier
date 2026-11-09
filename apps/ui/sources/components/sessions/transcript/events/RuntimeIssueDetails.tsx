import * as React from 'react';
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { presentSessionRuntimeIssue } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import {
  DisclosedCodeText,
  useCoreDisclosureToggleBinding,
} from '@/components/ui/lists/DisclosureCaret';
import { t } from '@/text';

/** A failure row's raw cause (code, provider code, request id) behind Details, as on worker update cards. */
export function RuntimeIssueDetails(
  props: Readonly<{ issue: SessionRuntimeIssueV1 }>,
) {
  const details = presentSessionRuntimeIssue(props.issue).details;
  const disclosure = useCoreDisclosureToggleBinding();
  const [open, setOpen] = React.useState(false);
  if (!details) return null;
  return (
    <>
      <HappierDisclosureToggle
        testID="transcript-event-runtime-issue-details-toggle"
        label={t('common.details')}
        open={open}
        onPress={() => setOpen((value) => !value)}
        caret={disclosure.renderCaret(open)}
        renderLabel={disclosure.renderLabel}
        focusColor={disclosure.focusColor}
      />
      {open ? (
        <DisclosedCodeText testID="transcript-event-runtime-issue-details-code">
          {details}
        </DisclosedCodeText>
      ) : null}
    </>
  );
}
