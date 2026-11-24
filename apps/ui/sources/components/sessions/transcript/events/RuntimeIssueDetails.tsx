import * as React from 'react';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { presentSessionRuntimeIssue } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { t } from '@/text';

/** A failure's raw cause (code, provider code, request id) behind the one Technical details disclosure. */
export function RuntimeIssueDetails(
  props: Readonly<{ issue: SessionRuntimeIssueV1 }>,
) {
  const lines = presentSessionRuntimeIssue(props.issue).technicalLines;
  return (
    <TechnicalDetailsDisclosure
      testID="transcript-event-runtime-issue-details-toggle"
      title={t('approvals.technicalDetails')}
      lines={lines}
    />
  );
}
