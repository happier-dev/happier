import { describe, expect, it } from 'vitest';

import {
  AutomationRunCauseSchema,
  AutomationTriggerIdSchema,
} from './automationRunCause.js';

describe('AutomationRunCauseSchema', () => {
  it('retains immutable trigger identity and bounded occurrence provenance', () => {
    const cause = AutomationRunCauseSchema.parse({
      kind: 'trigger',
      triggerId: 'trigger-1',
      triggerRevision: 3,
      triggerKind: 'pluginEvent',
      occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      occurredAt: 1_700_000_000_000,
      evidence: { sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631' },
    });

    expect(cause).toMatchObject({
      kind: 'trigger',
      triggerId: AutomationTriggerIdSchema.parse('trigger-1'),
      triggerKind: 'pluginEvent',
    });
    expect(AutomationRunCauseSchema.safeParse({ ...cause, origin: 'pluginEvent' }).success).toBe(false);
  });

  it('keeps direct manual and conversation causes operation-scoped', () => {
    expect(AutomationRunCauseSchema.parse({
      kind: 'manual',
      invokedAt: 1_700_000_000_000,
    })).toEqual({ kind: 'manual', invokedAt: 1_700_000_000_000 });

    expect(AutomationRunCauseSchema.parse({
      kind: 'conversation',
      occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      occurredAt: 1_700_000_000_000,
    })).not.toHaveProperty('triggerId');
  });
});
