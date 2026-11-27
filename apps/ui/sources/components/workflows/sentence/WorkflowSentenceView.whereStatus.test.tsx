import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { useControlledWorkflowEditorDraftStore } from '@/components/workflows/editor/workflowEditorDraftStore';
import { WorkflowTriggerSection } from '@/components/workflows/triggers/WorkflowTriggerSection';
import { createWorkflowTriggerIncompleteSeed } from '@/components/workflows/triggers/workflowTriggerStarts';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';

import { WorkflowSentenceView } from './WorkflowSentenceView';

afterEach(standardCleanup);

const MACHINE_ID = 'watching-machine';
const draft: WorkflowEditorDraft = {
  draftId: 'starter',
  name: 'Investigate',
  version: 1,
  defaults: {},
  inputs: [],
  blocks: [],
};
const nativeEvent = {
  key: 'presence',
  kind: 'machine',
  machineId: MACHINE_ID,
  event: 'online',
  sourceRevision: 1,
  occurredAt: 10,
  coverage: 'live',
} as const;

function Starter(
  props: Readonly<{
    incomplete: NonNullable<
      ReturnType<typeof createWorkflowTriggerIncompleteSeed>
    >;
  }>,
) {
  const draftStore = useControlledWorkflowEditorDraftStore(draft);
  const target = { machineId: MACHINE_ID, directory: '~' };
  return (
    <WorkflowSentenceView
      draftStore={draftStore}
      onChange={vi.fn()}
      documentEditable
      selectedBlockId={null}
      onSelectBlock={vi.fn()}
      renderStepCard={() => null}
      place={{ target, machineName: null }}
      testIDPrefix="b"
      whenClause={
        <WorkflowTriggerSection
          testIDPrefix="b"
          presentation="sentence"
          set={null}
          draft={{ adds: [], updates: {}, removes: [] }}
          onChangeDraft={vi.fn()}
          status="ready"
          onRetry={vi.fn()}
          stepsUnsaved
          whereTarget={target}
          whereSummary={null}
          inputs={[]}
          incomplete={{ state: props.incomplete, onChange: vi.fn() }}
        />
      }
    />
  );
}

it('reads the watching Machine\'s reason under the "on ⟨Machine⟩" line it names, not under When (R15 Deployment starter)', async () => {
  const incomplete = createWorkflowTriggerIncompleteSeed({ nativeEvent })!;
  const screen = await renderScreen(<Starter incomplete={incomplete} />);
  // Drawn (host) nodes only: the reason's owner element keeps its place in the When clause and draws nothing there.
  const drawn = (id: string) => (node: { type: unknown; props: Record<string, unknown> }) =>
    typeof node.type === 'string' && node.props.testID === id;
  const order = screen.findAll((node) => drawn('b-sentence-where')(node) || drawn('b-triggers-pending-reason')(node))
    .map((node) => node.props.testID as string);
  expect(order).toEqual(['b-sentence-where', 'b-triggers-pending-reason']);
});
