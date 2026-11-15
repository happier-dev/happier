import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { formatWorkflowSummaryLine } from './workflowSummaryLine';

const step = (id: string, name: string | undefined, text: string) => ({
  kind: 'step' as const,
  id,
  ...(name === undefined ? {} : { name }),
  document: { text, references: [], attachments: [] },
  input: [],
  result: { kind: 'text' as const },
});

/** The line under a workflow's title (owner 2026-11-15): generated from the workflow, never stored. */
describe('formatWorkflowSummaryLine', () => {
  it('reads when it runs, then each top-level step, as one line', () => {
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'Fix what broke',
      blocks: [
        step('a', 'Find the cause', 'Run the checks.'),
        step('b', 'Fix it', 'Fix it.'),
        step('c', 'Tell me', 'Notify me.'),
      ] as never,
    });
    expect(
      formatWorkflowSummaryLine(draft, { trigger: 'Every weekday at 09:00' }),
    ).toBe('Every weekday at 09:00 → find the cause → fix it → tell me');
  });

  it('starts with the steps when nothing starts it automatically', () => {
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'Ask',
      blocks: [step('a', 'Ask once', 'Answer.')] as never,
    });
    expect(formatWorkflowSummaryLine(draft, { trigger: null })).toBe(
      'Ask once',
    );
  });

  it('names an unnamed step by its prompt\'s first sentence, never "Agent step"', () => {
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'Ack',
      blocks: [
        step(
          'a',
          undefined,
          'Return a short QA acknowledgement. Do not change files.',
        ),
      ] as never,
    });
    const line = formatWorkflowSummaryLine(draft, { trigger: null });
    expect(line).toBe('Return a short QA acknowledgement');
    expect(line).not.toContain('workflows.editor.addStep');
  });

  it('keeps a word that is all capitals as written', () => {
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'PR',
      blocks: [step('a', 'Open', 'x'), step('b', 'PR review', 'y')] as never,
    });
    expect(formatWorkflowSummaryLine(draft, { trigger: null })).toBe(
      'Open → PR review',
    );
  });

  it('says nothing for an empty workflow', () => {
    const draft = createWorkflowEditorDraft({
      draftId: 'd',
      name: 'New',
      blocks: [step('a', undefined, '')] as never,
    });
    expect(formatWorkflowSummaryLine(draft, { trigger: null })).toBeNull();
  });
});
