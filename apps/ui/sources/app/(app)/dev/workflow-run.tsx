import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { WorkflowRunSpecimen } from '@/components/dev/workflowRun/WorkflowRunSpecimen';

/** Dev-only: Run detail specimen (workflows lab run-R1). `?scene=failed|succeeded|offline`. */
export default function WorkflowRunDevScreen() {
  const params = useLocalSearchParams<{ scene?: string }>();
  return (
    <WorkflowRunSpecimen
      scene={
        params.scene === 'succeeded' || params.scene === 'offline'
          ? params.scene
          : 'failed'
      }
    />
  );
}
