import * as React from 'react';

import { t } from '@/text';

import { WorkflowCardGutterRow, WorkflowKindCard } from './WorkflowKindCard';

/**
 * "When it runs" (owner 2026-11-15, lab round 1115 r16 "Two cards"): the page's first card, triggers
 * only. Its header says when the workflow runs in one sentence (the trigger owner's summary); its
 * body is the trigger owner's section, so every trigger kind is added and edited where it reads.
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
    <WorkflowCardGutterRow icon="clock">
      <WorkflowKindCard
        testID={`${props.testIDPrefix}-when`}
        title={t('workflows.page.sections.whenTitle')}
        summary={props.summary}
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
