import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const { describeWorkflowRunDestinationProgress } =
  await import('./workflowRunProgress');

type Progress = Parameters<typeof describeWorkflowRunDestinationProgress>[0];

const progress = (name: string): Progress =>
  ({
    completed: 0,
    total: 2,
    destinations: [
      {
        blockId: 'a',
        sourceKey: '$root',
        ordinal: 1,
        name,
        sessionIds: ['s1'],
      },
      {
        blockId: 'b',
        sourceKey: '$root',
        ordinal: 2,
        name: 'Post the digest',
        sessionIds: ['s2'],
      },
    ],
  }) as unknown as Progress;

describe('describeWorkflowRunDestinationProgress', () => {
  it('names the step that writes into this Session', () => {
    expect(
      describeWorkflowRunDestinationProgress(
        progress('Summarize notes'),
        's1',
        'Memory upkeep',
      ),
    ).toEqual(['sessionWork.scheduled.step(ordinal=1,title=Summarize notes)']);
  });

  it('says nothing a row title already says: a step named like its Run is not repeated (owner 0936 #14)', () => {
    expect(
      describeWorkflowRunDestinationProgress(
        progress('Memory upkeep'),
        's1',
        'Memory upkeep',
      ),
    ).toEqual([]);
  });
});
