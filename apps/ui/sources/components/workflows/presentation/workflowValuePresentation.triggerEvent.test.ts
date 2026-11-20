import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { formatWorkflowFieldLabel, formatWorkflowValueReference } =
  await import('./workflowValuePresentation');

describe('a trigger event reference read as words (#184 F3)', () => {
  it('names a plugin Event by its own name in words, never by the raw plugin and Event ids', () => {
    const label = formatWorkflowValueReference(
      { blocks: [] },
      {
        kind: 'trigger_event',
        event: { pluginId: 'happier.sentry', localId: 'issue-transition' },
        path: ['issueRef'],
      },
    );
    expect(label).not.toContain('happier.sentry');
    expect(label).not.toContain('/');
    expect(label).toBe(
      `Issue transition · ${formatWorkflowFieldLabel('issueRef')}`,
    );
  });

  it('names an Action phase event in words', () => {
    const label = formatWorkflowValueReference(
      { blocks: [] },
      {
        kind: 'trigger_event',
        event: { kind: 'action', phase: 'before' },
        path: [],
      },
    );
    expect(label).toBe('Before action');
  });
});
