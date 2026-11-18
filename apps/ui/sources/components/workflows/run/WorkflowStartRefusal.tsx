import * as React from 'react';

import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { WorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { t } from '@/text';

/**
 * A refused Workflow start, said where the person pressed Start: the canonical problem's title and
 * message, with its phase and code under Technical details. Every surface that takes an `inline`
 * refusal from the Run-now controller draws it here.
 */
export function WorkflowStartRefusal(
  props: Readonly<{
    refusal: WorkflowProblemPresentation | null;
    testID: string;
  }>,
) {
  const { refusal } = props;
  if (!refusal) return null;
  return (
    <>
      <SurfaceStateCard
        testID={props.testID}
        size="line"
        kind={
          refusal.accessibilitySemantics === 'status' ? 'unavailable' : 'error'
        }
        title={refusal.title}
        reason={refusal.message}
        accessibilitySemantics={refusal.accessibilitySemantics}
      />
      {refusal.technicalDetails ? (
        <TechnicalDetailsDisclosure
          title={t('workflows.run.technicalDetails')}
          lines={refusal.technicalDetails}
        />
      ) : null}
    </>
  );
}
