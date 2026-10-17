import { describe, expect, it } from 'vitest';

import {
  mcpElicitationFormContent,
  mcpElicitationFormQuestions,
  parseMcpElicitationFormSchema,
} from './mcpElicitationForm';

describe('mcpElicitationForm', () => {
  it('preserves option descriptions, string defaults, and single-question message fallback', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        value: {
          type: 'string',
          default: 'approve',
          oneOf: [
            {
              const: 'approve',
              title: 'Approve plan',
              description: 'Exit plan mode and execute the plan',
            },
            {
              const: 'refine',
              title: 'Refine plan',
              description: 'Stay in plan mode and iterate',
            },
          ],
        },
      },
      required: ['value'],
    });

    const questions = mcpElicitationFormQuestions(schema, {
      message: 'Approve plan ready at plan://session/plan.md?',
    });

    expect(questions).toEqual([
      {
        id: 'value',
        prompt: 'Approve plan ready at plan://session/plan.md?',
        type: 'singleChoice',
        required: true,
        choices: [
          {
            id: 'approve',
            label: 'Approve plan',
            description: 'Exit plan mode and execute the plan',
          },
          {
            id: 'refine',
            label: 'Refine plan',
            description: 'Stay in plan mode and iterate',
          },
        ],
      },
    ]);

    const textSchema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          default: 'Initial draft',
        },
      },
      required: ['notes'],
    });
    expect(
      mcpElicitationFormQuestions(textSchema, {
        message: 'Provide notes:',
      }),
    ).toEqual([
      {
        id: 'notes',
        prompt: 'Provide notes:',
        type: 'text',
        required: true,
        initialValue: 'Initial draft',
      },
    ]);
  });

  it('collapses companion __other fields into allowCustom choice questions and maps custom answers back to __other', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          title: 'Target scope',
          oneOf: [
            { const: 'cli', title: 'CLI', description: 'Command line package' },
            { const: 'ui', title: 'UI', description: 'Expo UI package' },
            { const: 'Other (type your own)', title: 'Other (type your own)' },
          ],
        },
        scope__other: {
          type: 'string',
          title: 'Other (type your own)',
        },
        tags: {
          type: 'array',
          title: 'Select tags',
          items: {
            type: 'string',
            anyOf: [
              { const: 'acp', title: 'ACP', description: 'Agent Client Protocol' },
              { const: 'mcp', title: 'MCP', description: 'Model Context Protocol' },
              { const: 'Other (type your own)', title: 'Other (type your own)' },
            ],
          },
        },
        tags__other: {
          type: 'string',
          title: 'Other (type your own)',
        },
      },
      required: ['scope', 'tags'],
    });

    const questions = mcpElicitationFormQuestions(schema);
    expect(questions).toEqual([
      {
        id: 'scope',
        prompt: 'Target scope',
        type: 'singleChoice',
        required: true,
        allowCustom: true,
        choices: [
          { id: 'cli', label: 'CLI', description: 'Command line package' },
          { id: 'ui', label: 'UI', description: 'Expo UI package' },
        ],
      },
      {
        id: 'tags',
        prompt: 'Select tags',
        type: 'multipleChoice',
        required: true,
        allowCustom: true,
        choices: [
          { id: 'acp', label: 'ACP', description: 'Agent Client Protocol' },
          { id: 'mcp', label: 'MCP', description: 'Model Context Protocol' },
        ],
      },
    ]);

    const content = mcpElicitationFormContent(schema, {
      scope: {
        kind: 'singleChoice',
        answer: { kind: 'custom', value: 'Custom scope' },
      },
      tags: {
        kind: 'multipleChoice',
        answers: [
          { kind: 'choice', choiceId: 'acp' },
          { kind: 'custom', value: 'Custom tag' },
        ],
      },
    });

    expect(content).toEqual({
      scope: 'Other (type your own)',
      scope__other: 'Custom scope',
      tags: ['acp', 'Other (type your own)'],
      tags__other: 'Custom tag',
    });
  });

  it('matches lower-case choice IDs for "other" companion fields and retains the choice ID', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          title: 'Selection',
          oneOf: [
            { const: 'first', title: 'First option' },
            { const: 'other', title: 'Other' },
          ],
        },
        choice__other: {
          type: 'string',
          title: 'Other',
        },
      },
      required: ['choice'],
    });

    const questions = mcpElicitationFormQuestions(schema);
    expect(questions).toEqual([
      {
        id: 'choice',
        prompt: 'Selection',
        type: 'singleChoice',
        required: true,
        allowCustom: true,
        choices: [
          { id: 'first', label: 'First option' },
        ],
      },
    ]);

    const content = mcpElicitationFormContent(schema, {
      choice: {
        kind: 'singleChoice',
        answer: { kind: 'custom', value: 'My custom response' },
      },
    });

    expect(content).toEqual({
      choice: 'other',
      choice__other: 'My custom response',
    });
  });

  it('does not collapse companion __other if the base property is required and has no matching other choice', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          title: 'Selection',
          oneOf: [
            { const: 'first', title: 'First option' },
            { const: 'second', title: 'Second option' },
          ],
        },
        choice__other: {
          type: 'string',
          title: 'Additional details',
        },
      },
      required: ['choice'],
    });

    const questions = mcpElicitationFormQuestions(schema);
    // Both properties must remain separate so the required 'choice' field is not dropped on custom input
    expect(questions).toHaveLength(2);
    expect(questions?.map((q) => q.id)).toEqual(['choice', 'choice__other']);
  });

  it('preserves plan summaries exceeding 512 code points when property has its own title', () => {
    const longPlan = `### Plan Steps\n\n${'- Step description in detail with reasoning.\n'.repeat(15)}`;
    expect(Array.from(longPlan).length).toBeGreaterThan(512);

    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: 'Decision',
          oneOf: [
            { const: 'approve', title: 'Approve' },
            { const: 'refine', title: 'Refine' },
          ],
        },
      },
      required: ['decision'],
    });

    const questions = mcpElicitationFormQuestions(schema, { message: longPlan });
    expect(questions).toHaveLength(1);
    expect(questions![0].prompt).toContain(longPlan);
    expect(questions![0].prompt).toContain('Decision');
  });

  it('bounds long prompts to MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1 (4,096 code points)', () => {
    const hugePlan = 'Very detailed plan text line.\n'.repeat(300); // ~9,000 characters
    expect(Array.from(hugePlan).length).toBeGreaterThan(4_096);

    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          oneOf: [
            { const: 'approve', title: 'Approve' },
            { const: 'refine', title: 'Refine' },
          ],
        },
      },
      required: ['decision'],
    });

    const questions = mcpElicitationFormQuestions(schema, { message: hugePlan });
    expect(questions).toHaveLength(1);
    expect(Array.from(questions![0].prompt).length).toBeLessThanOrEqual(4_096);
    expect(questions![0].prompt).toContain('... [truncated]');
  });

  it('returns null for empty-property confirmation schemas', () => {
    const schema = parseMcpElicitationFormSchema({
      type: 'object',
      properties: {},
    });
    expect(mcpElicitationFormQuestions(schema, { message: 'Confirm?' })).toBeNull();
  });
});
