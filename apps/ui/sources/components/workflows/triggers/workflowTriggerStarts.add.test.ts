import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { addWorkflowTriggerWhen } = await import('./workflowTriggerStarts');
const { EMPTY_WORKFLOW_TRIGGER_DRAFT } = await import('./workflowTriggerDraft');
const { EMPTY_WORKFLOW_TRIGGER_INCOMPLETE } =
  await import('./workflowTriggerStarts');
const { createDefaultWhen } = await import('./sessionTriggerForm');

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
