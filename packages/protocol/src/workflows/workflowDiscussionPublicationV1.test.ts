import { describe, expect, it } from 'vitest';
import { DiscussionMessageContentV1Schema } from '../discussions/content.js';
import {
  isWorkflowDiscussionResultPublishableV1,
  projectWorkflowDiscussionProducerV1,
  projectWorkflowDiscussionResultContentV1,
} from './workflowDiscussionPublicationV1.js';

const result = {
  runId: 'run', invocationRecordId: 'leaf', invocationAttempt: '0', blockKind: 'action',
  execution: { kind: 'action', actionId: 'plugin:external/check' },
};

describe('Workflow Discussion result publication', () => {
  it.each(['cancelled', 'failed'])('leaves %s outcomes in Run history without publishing a message', lifecycle => {
    for (const value of [undefined, { checked: true }, 'partial']) {
      const input = { ...result, lifecycle, result: value };
      expect(isWorkflowDiscussionResultPublishableV1(input)).toBe(false);
      expect(projectWorkflowDiscussionProducerV1(input)).toBeNull();
      expect(projectWorkflowDiscussionResultContentV1(input)).toBeNull();
    }
  });

  it('keeps the finished external Action summary and strict consumer content unchanged', () => {
    const input = { ...result, lifecycle: 'completed', result: { checked: true } };
    expect(isWorkflowDiscussionResultPublishableV1(input)).toBe(true);
    expect(projectWorkflowDiscussionProducerV1(input)).toMatchObject({ outcome: 'answer', execution: result.execution });
    expect(DiscussionMessageContentV1Schema.parse(projectWorkflowDiscussionResultContentV1(input)))
      .toEqual({ v: 1, parts: [{ t: 'text', text: 'The requested work finished.' }] });
  });
});
