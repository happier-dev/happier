import * as React from 'react';

import { t } from '@/text';

import { WorkflowCardGutterRow, WorkflowKindCard } from './WorkflowKindCard';

/**
 * "When it runs" (owner 2026-11-15, lab round 1115 r16 "Two cards"): the page's first card, triggers
 * only. The collapsed header reads the trigger owner's summary. The expanded body presents the
 * individual trigger sentences beside their controls.
 */
export function WorkflowWhenItRunsCard(
  props: Readonly<{
    /** The trigger owner's one-sentence summary ("Every weekday at 09:00"). */
    summary: string;
    /** The trigger owner's section (`WorkflowEditorTriggerSection`). */
    children: React.ReactNode;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  return (
    // How and where it runs always follows, so the spine runs on to its mark.
    <WorkflowCardGutterRow icon="clock" spineTo="card">
      <WorkflowKindCard
        testID={`${props.testIDPrefix}-when`}
        title={t('workflows.page.sections.whenTitle')}
        summary={props.expanded ? undefined : props.summary}
        disclosure={{
          expanded: props.expanded,
          onExpandedChange: props.onExpandedChange,
        }}
      >
        {props.children}
      </WorkflowKindCard>
    </WorkflowCardGutterRow>
  );
}
