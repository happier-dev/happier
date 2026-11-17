import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  WorkflowSentenceSpecimen,
  type WorkflowSentenceSpecimenScene,
} from '@/components/dev/workflowSentence/WorkflowSentenceSpecimen';

const SCENES: readonly WorkflowSentenceSpecimenScene[] = ['step1', 'step2', 'step3', 'options', 'empty', 'conditional', 'conditionalBranch'];

/** Dev-only: the workflow editor's Sentence view (workflows lab round 1116c). `?scene=step1|step2|step3|options|empty`. */
export default function WorkflowSentenceDevScreen() {
  const params = useLocalSearchParams<{ scene?: string }>();
  const scene = SCENES.find((candidate) => candidate === params.scene) ?? 'step1';
  return <WorkflowSentenceSpecimen key={scene} scene={scene} />;
}
