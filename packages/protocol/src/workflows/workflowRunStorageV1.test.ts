import { describe, expect, it } from 'vitest';

import * as workflows from './index.js';

describe('Workflow storage operation authority', () => {
  it('requires executor proof for worker writes and unknown operations while admitting Account reads and controls', () => {
    const classifier = workflows.isWorkflowRunExecutorStorageOperationV1;
    expect(classifier).toBeTypeOf('function');
    for (const operation of ['get', 'read_state.set', 'wait', 'list', 'invocations.list', 'invocations.get', 'invocations.current', 'invocations.publish_draft', 'invocations.complete_review', 'pause', 'resume', 'cancel', 'delete', 'run-key.census', 'run-key.commit']) {
      expect(classifier(operation)).toBe(false);
    }
    for (const operation of ['admit', 'initialize', 'accepted-snapshot.resolve', 'invocations.admit', 'invocations.fact', 'invocations.recover', 'transition', 'recovery.list', 'result-delivery.settle', 'future-operation', undefined]) {
      expect(classifier(operation)).toBe(true);
    }
  });
});
