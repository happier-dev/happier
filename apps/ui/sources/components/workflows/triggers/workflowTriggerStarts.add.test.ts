import { describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerAddRequestV1Schema, WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { addWorkflowTriggerWhen } = await import('./workflowTriggerStarts');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT, saveWorkflowTriggerDraft } = await import('./workflowTriggerDraft');
const { EMPTY_WORKFLOW_TRIGGER_INCOMPLETE } =
  await import('./workflowTriggerStarts');
const { createDefaultWhen } = await import('./sessionTriggerForm');
const { readWorkflowEventWhen } = await import('../events/workflowEventFacts');

type Draft = typeof EMPTY_WORKFLOW_TRIGGER_DRAFT;
type Incomplete = typeof EMPTY_WORKFLOW_TRIGGER_INCOMPLETE;

function host() {
  const state: { draft: Draft; incomplete: Incomplete } = {
    draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
    incomplete: EMPTY_WORKFLOW_TRIGGER_INCOMPLETE,
  };
  return {
    state,
    add: (when: ReturnType<typeof createDefaultWhen>) =>
      addWorkflowTriggerWhen({
        draft: state.draft,
        when,
        onChangeDraft: (next) => {
          state.draft = next;
        },
        updateIncomplete: (update) => {
          state.incomplete = update(state.incomplete);
        },
      }),
  };
}

describe('addWorkflowTriggerWhen', () => {
  it.each(['terminal', 'needs_attention'] as const)('saves a configured %s Run Event added from Live events', async event => {
    const when = readWorkflowEventWhen({ kind: 'run', key: 'run-event', runId: 'source-run', event,
      state: 'succeeded', sourceRevision: 3, occurredAt: 100, coverage: 'live' });
    expect(when).not.toBeNull();
    const editor = host();
    editor.add(when!);
    const project = { machineId: 'machine-1', directory: '/work/project' };
    const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'set-1', revision: 1, enabled: true,
      health: 'available', project, triggers: [] });
    // The Action transport is the boundary; seed construction, draft completion and Save stay real.
    const add = vi.fn(async (request: unknown) => {
      WorkflowTriggerAddRequestV1Schema.parse(request);
      return { set };
    });
    const unusedWrite = async () => { throw new Error('unexpected existing-trigger write'); };
    const result = await saveWorkflowTriggerDraft({ workflow: '11111111-1111-4111-8111-111111111111',
      project, set: null, draft: editor.state.draft,
      writer: { add, update: unusedWrite, remove: unusedWrite } });
    expect(result.kind).toBe('saved');
    expect(add).toHaveBeenCalledWith({ workflow: '11111111-1111-4111-8111-111111111111', project,
      trigger: { kind: 'runLifecycle', source: { kind: 'workflow_run', runId: 'source-run' }, condition: event, enabled: true } });
    expect(editor.state.incomplete.pending).toHaveLength(0);
  });

  it('adds a complete When to the draft as a new trigger', () => {
    const editor = host();
    editor.add(createDefaultWhen('turnStarts'));
    expect(editor.state.draft.adds).toHaveLength(1);
    expect(editor.state.draft.adds[0]?.trigger).toMatchObject({
      kind: 'sessionLifecycle',
      enabled: true,
    });
    expect(editor.state.incomplete.pending).toHaveLength(0);
  });

  it('holds an incomplete When beside the draft until it is set up', () => {
    const editor = host();
    editor.add({
      kind: 'pluginEvent',
      value: null,
      eventRef: { pluginId: 'p', localId: 'e' },
    });
    expect(editor.state.draft.adds).toHaveLength(0);
    expect(editor.state.incomplete.pending).toHaveLength(1);
  });
});
