import { useState } from 'react';
import {
  Button, Stack, WorkflowRunFoldHeader,
} from '@happier-dev/plugin-ui/components';
import { usePluginHostApi } from '@happier-dev/plugin-ui/hostApi';
import {
  pauseExternalWorkflowThroughUi, startExternalWorkflowThroughUi,
  type ExternalWorkflowStartInput,
} from './workflowPattern.js';

/** A controlled author surface: the host owns admission, lifecycle and navigation. */
export function WorkflowPatternExample(props: Readonly<{ input: ExternalWorkflowStartInput }>) {
  const host = usePluginHostApi();
  const [run, setRun] = useState<Readonly<{ id: string; revision: number; availability: Readonly<{ pause: boolean }> }> | null>(null);
  return <Stack>
    <Button title="Start contributed Workflow" onPress={async () => {
      const result = await startExternalWorkflowThroughUi(host, props.input);
      if ('run' in result) setRun(result.run);
    }} />
    {run ? <WorkflowRunFoldHeader runId={run.id} disclosure={null}
      presentation={{ verb: 'Independent review', details: [], meta: null }}
      onOpen={null} openLabel="Open"
      actions={run.availability.pause ? <Button title="Pause contributed Workflow" onPress={async () => {
        const result = await pauseExternalWorkflowThroughUi(host, { runId: run.id, expectedRevision: run.revision });
        if ('run' in result) setRun(result.run);
      }} /> : null} /> : null}
  </Stack>;
}
