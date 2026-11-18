import { describe, expect, it, vi } from 'vitest';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowStep } from '@happier-dev/protocol/workflows/workflowV1';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import {
  validateWorkflowEditorDraft,
  workflowIssuesForBlock,
} from '@/sync/domains/workflows/workflowAuthoring';
import {
  insertWorkflowActionFieldValue,
  listWorkflowActionFieldTextParts,
  readWorkflowActionFieldText,
  writeWorkflowActionFieldText,
} from './workflowActionTextField';
import { collectWorkflowFieldIssueTexts } from './workflowIssueText';
import { createWorkflowPromptSuggestions } from './workflowPromptSuggestions';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const analysis: WorkflowStep = {
  kind: 'step',
  id: 'analyze',
  name: 'Analysis',
  document: { text: 'Analyze', references: [], attachments: [] },
  input: [],
  result: { kind: 'text' },
};
const result = {
  kind: 'result' as const,
  producer: { blockId: 'analyze', scope: { kind: 'current' as const } },
  path: [],
};
const tokenFor = (label: string, index: number) =>
  formatInlineReferenceTokenV1({ label, ref: `workflowInput:${index}` });
const labelFor = () => 'Analysis result';

describe('Action text field seam', () => {
  it('reads a field as editable text only when it holds text, and writes edits back as the narrowest binding', () => {
    expect(readWorkflowActionFieldText(undefined, labelFor)).toEqual({
      kind: 'text',
      document: { text: '', references: [] },
      input: [],
    });
    expect(
      readWorkflowActionFieldText(
        { kind: 'literal', value: 'Ship it' },
        labelFor,
      )?.document.text,
    ).toBe('Ship it');
    expect(
      readWorkflowActionFieldText({ kind: 'literal', value: 3 }, labelFor),
    ).toBeNull();
    expect(
      readWorkflowActionFieldText({ kind: 'list', items: [] }, labelFor),
    ).toBeNull();
    // A whole value opens as one value inside the text, so the person can type around it.
    const whole = readWorkflowActionFieldText(result, labelFor)!;
    expect(whole).toEqual({
      kind: 'text',
      input: [result],
      document: {
        text: tokenFor('Analysis result', 0),
        references: [
          {
            kind: 'happier.workflowInput',
            ref: 'workflowInput:0',
            label: 'Analysis result',
            token: tokenFor('Analysis result', 0),
          },
        ],
      },
    });
    expect(writeWorkflowActionFieldText(whole, whole.document)).toEqual(result);
    const typed = writeWorkflowActionFieldText(whole, {
      ...whole.document,
      text: `Fix ${whole.document.text} now`,
    });
    expect(typed).toMatchObject({
      kind: 'text',
      input: [result],
      document: { text: `Fix ${tokenFor('Analysis result', 0)} now` },
    });
    expect(
      writeWorkflowActionFieldText(whole, {
        text: 'no values',
        references: [],
      }),
    ).toEqual({ kind: 'literal', value: 'no values' });
  });

  it('inserts a value at the caret, reusing the binding a value already has', () => {
    const field = readWorkflowActionFieldText(
      { kind: 'literal', value: 'Fix  now' },
      labelFor,
    )!;
    const once = insertWorkflowActionFieldValue(field, {
      reference: result,
      label: 'Analysis',
      selection: { start: 4, end: 4 },
    });
    expect(once).toMatchObject({
      kind: 'text',
      input: [result],
      document: { text: `Fix ${tokenFor('Analysis', 0)} now` },
    });
    const twice = insertWorkflowActionFieldValue(
      readWorkflowActionFieldText(once, labelFor)!,
      { reference: result, label: 'Analysis' },
    );
    expect(twice).toMatchObject({
      kind: 'text',
      input: [result],
      document: {
        text: `Fix ${tokenFor('Analysis', 0)} now${tokenFor('Analysis', 0)}`,
      },
    });
    if (twice.kind !== 'text') throw new Error('expected text with values inside');
    expect(listWorkflowActionFieldTextParts(twice)).toEqual([
      { kind: 'text', text: 'Fix ' },
      { kind: 'value', label: 'Analysis', reference: result },
      { kind: 'text', text: ' now' },
      { kind: 'value', label: 'Analysis', reference: result },
    ]);
    // Inserting into an empty field is the whole value, as before.
    expect(
      insertWorkflowActionFieldValue(
        readWorkflowActionFieldText(undefined, labelFor)!,
        { reference: result, label: 'Analysis' },
      ),
    ).toEqual(result);
  });

  it('offers the same @ value list as a prompt and marks a value the field can no longer read', () => {
    const action: WorkflowActionLeafV1 = {
      kind: 'action',
      id: 'hook',
      actionId: 'webhooks.call',
      input: {
        url: {
          kind: 'text',
          input: [result],
          document: {
            text: `https://x.test/${tokenFor('Analysis', 0)}`,
            references: [
              {
                kind: 'happier.workflowInput',
                ref: 'workflowInput:0',
                label: 'Analysis',
                token: tokenFor('Analysis', 0),
              },
            ],
          },
        },
        body: { kind: 'literal', value: {} },
      },
    };
    const draft = createWorkflowEditorDraft({
      draftId: 'action-text',
      blocks: [analysis, action],
    });
    const field = action.input.url!;
    if (field.kind !== 'text') throw new Error('fixture');
    const change = vi.fn();
    const suggestions = createWorkflowPromptSuggestions({
      draft,
      step: { id: action.id, input: field.input },
      query: '@',
      onChangeInput: change,
    });
    expect(
      suggestions.find((row) => row.label?.includes('Analysis'))
        ?.structuredInput,
    ).toMatchObject({ ref: 'workflowInput:0' });
    // The field's revealed issue (the Action row's `fieldIssues`) names a value it can no longer read.
    const urlIssueFor = (
      blocks: Parameters<typeof createWorkflowEditorDraft>[0]['blocks'],
    ) => {
      const next = createWorkflowEditorDraft({
        draftId: 'action-text-states',
        blocks,
      });
      return collectWorkflowFieldIssueTexts(
        workflowIssuesForBlock(validateWorkflowEditorDraft(next), action.id, next),
        next,
      ).url;
    };
    expect(urlIssueFor([analysis, action])).toBeUndefined();
    expect(urlIssueFor([action, analysis])).toEqual(expect.any(String));
    expect(urlIssueFor([action])).toEqual(expect.any(String));
  });
});
