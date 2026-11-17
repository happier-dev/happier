import * as React from 'react';

import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';

import {
  createMachineFixture,
  createMachineMetadataFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import {
  WorkflowEditorBody,
  type WorkflowEditorView,
} from '@/components/workflows/screens/WorkflowEditorBody';
import { useControlledWorkflowEditorDraftStore } from '@/components/workflows/editor/workflowEditorDraftStore';
import { WorkflowTriggerSection } from '@/components/workflows/triggers/WorkflowTriggerSection';
import {
  EMPTY_WORKFLOW_TRIGGER_INCOMPLETE,
  type WorkflowTriggerIncomplete,
} from '@/components/workflows/triggers/workflowTriggerStarts';
import type { WorkflowTriggerDraft } from '@/components/workflows/triggers/workflowTriggerDraft';
import {
  createWorkflowEditorDraft,
  type WorkflowEditorDraft,
} from '@/sync/domains/workflows/workflowEditorDraft';
import type { WorkflowAuthoringTarget } from '@/sync/domains/workflows/workflowProjectTarget';

/**
 * Dev-only specimen of the workflow editor's Sentence view (workflows lab round 1116c), rendered through the
 * real editor body, trigger section, Where, Result and step-card owners with fixture data. No RPC is issued
 * and nothing is saved. `?scene=step1|step2|step3|options|empty`.
 */
export type WorkflowSentenceSpecimenScene =
  | 'step1'
  | 'step2'
  | 'step3'
  | 'options'
  | 'empty'
  | 'conditional'
  | 'conditionalBranch';

const MACHINE = createMachineFixture({
  id: 'specimen-machine',
  metadata: createMachineMetadataFixture({
    host: 'macbook-pro',
    displayName: 'MacBook Pro',
    homeDir: '/Users/leeroy',
  }),
});

const STEPS: readonly WorkflowBlock[] = [
  {
    kind: 'step',
    id: 'cause',
    name: 'Find the cause',
    document: {
      text: 'Run the checks on main and find what broke.',
      references: [],
      attachments: [],
    },
    input: [],
    result: { kind: 'text' },
  },
  {
    kind: 'step',
    id: 'fix',
    name: 'Check the fix',
    document: {
      text: 'Check that the proposed fix makes the checks pass again.',
      references: [],
      attachments: [],
    },
    input: [],
    result: { kind: 'text' },
  },
  {
    kind: 'action',
    id: 'tell',
    name: 'Tell me',
    actionId: 'notifications.notify_me',
    input: { message: { kind: 'literal', value: 'The checks pass again.' } },
  },
];

/** Reviews lab prauto-sentence: an If whose then and otherwise branches each review the pull request. */
const CONDITIONAL: readonly WorkflowBlock[] = [
  {
    kind: 'if',
    id: 'outsider',
    when: {
      kind: 'compare',
      operator: 'eq',
      left: { kind: 'input', name: 'authorAssociation' },
      right: { kind: 'literal', value: 'first-time contributor' },
    },
    then: [
      {
        kind: 'wait',
        id: 'approve',
        name: 'ask me first',
        document: { text: 'Wait for my approval.', references: [], attachments: [] },
      },
      {
        kind: 'step',
        id: 'review-deep',
        name: 'Review with Claude and Codex',
        document: { text: 'Review the pull request.', references: [], attachments: [] },
        input: [],
        result: { kind: 'text' },
      },
    ],
    otherwise: [
      {
        kind: 'step',
        id: 'review-quick',
        name: 'Review with Claude',
        document: { text: 'Review the pull request.', references: [], attachments: [] },
        input: [],
        result: { kind: 'text' },
      },
    ],
  },
];

const DAILY_TRIGGERS: WorkflowTriggerDraft = {
  adds: [
    {
      clientId: 'specimen-daily',
      trigger: {
        kind: 'schedule',
        enabled: true,
        schedule: {
          kind: 'cron',
          scheduleExpr: '0 9 * * 1-5',
          everyMs: null,
          timezone: null,
        },
      },
    },
  ],
  updates: {},
  removes: [],
};

function createSpecimenDraft(
  scene: WorkflowSentenceSpecimenScene,
): WorkflowEditorDraft {
  const draft = createWorkflowEditorDraft({
    draftId: `sentence-specimen-${scene}`,
    name: scene === 'empty' ? '' : 'Fix what broke',
    blocks: scene === 'empty' ? [] : scene === 'conditional' || scene === 'conditionalBranch' ? CONDITIONAL : STEPS,
  });
  return scene === 'empty'
    ? draft
    : {
        ...draft,
        finalOutput: {
          kind: 'result',
          producer: {
            blockId: scene === 'conditional' || scene === 'conditionalBranch' ? 'review-deep' : 'fix',
            scope: { kind: 'current' },
          },
          path: [],
        },
      };
}

export function WorkflowSentenceSpecimen(
  props: Readonly<{ scene: WorkflowSentenceSpecimenScene }>,
) {
  const [draft, setDraft] = React.useState(() =>
    createSpecimenDraft(props.scene),
  );
  const draftStore = useControlledWorkflowEditorDraftStore(draft);
  const [view, setView] = React.useState<WorkflowEditorView>('sentence');
  const [selected, setSelected] = React.useState<string | null>(
    props.scene === 'step2' ? 'fix' : props.scene === 'step3' ? 'tell'
      : props.scene === 'conditionalBranch' ? 'review-deep' : null,
  );
  const [triggers, setTriggers] = React.useState(
    props.scene === 'empty'
      ? { adds: [], updates: {}, removes: [] }
      : DAILY_TRIGGERS,
  );
  const [incomplete, setIncomplete] = React.useState<WorkflowTriggerIncomplete>(
    EMPTY_WORKFLOW_TRIGGER_INCOMPLETE,
  );
  const [target, setTarget] = React.useState<WorkflowAuthoringTarget | null>(
    props.scene === 'empty'
      ? null
      : { machineId: MACHINE.id, directory: '/Users/leeroy/code/happier' },
  );
  const machineName = target === null ? null : 'MacBook Pro';
  return (
    <WorkflowEditorBody
      draftStore={draftStore}
      onChange={setDraft}
      machineName={machineName}
      projectTarget={target}
      projectMachines={[MACHINE]}
      onChangeProjectTarget={setTarget}
      composerScope={{ kind: 'machine', machineId: MACHINE.id }}
      selectedBlockId={selected}
      onSelectBlock={setSelected}
      onCustomizeBlock={() => {}}
      view={view}
      onChangeView={setView}
      onSave={() => {}}
      onRunNow={() => {}}
      triggersSummary=""
      triggersSentence={
        <WorkflowTriggerSection
          testIDPrefix="workflow-editor"
          presentation="sentence"
          set={null}
          draft={triggers}
          onChangeDraft={setTriggers}
          status="ready"
          onRetry={() => {}}
          stepsUnsaved={false}
          whereTarget={target}
          whereSummary={null}
          inputs={[]}
          incomplete={{ state: incomplete, onChange: setIncomplete }}
        />
      }
    />
  );
}
