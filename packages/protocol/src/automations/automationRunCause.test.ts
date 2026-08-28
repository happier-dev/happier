import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AutomationRunCauseSchema,
  AutomationTriggerIdSchema,
} from './automationRunCause.js';
import * as Protocol from '../index.js';

describe('AutomationRunCauseSchema', () => {
  it('is exported from the canonical Protocol entrypoint', () => {
    expect(Protocol.AutomationRunCauseSchema).toBe(AutomationRunCauseSchema);
  });

  it('retains immutable trigger identity and bounded occurrence provenance', () => {
    const cause = AutomationRunCauseSchema.parse({
      kind: 'trigger',
      triggerId: 'trigger-1',
      triggerRevision: 3,
      triggerKind: 'pluginEvent',
      occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      occurredAt: 1_700_000_000_000,
      evidence: {
        eventRef: { pluginId: 'com.example.github', localId: 'issue-opened-v1' },
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      },
    });

    expect(cause).toMatchObject({
      kind: 'trigger',
      triggerId: AutomationTriggerIdSchema.parse('trigger-1'),
      triggerKind: 'pluginEvent',
      evidence: { eventRef: { pluginId: 'com.example.github', localId: 'issue-opened-v1' } },
    });
    expect(AutomationRunCauseSchema.safeParse({ ...cause, origin: 'pluginEvent' }).success).toBe(false);
  });

  it('publishes a closed JSON Schema for every immutable cause arm', () => {
    const jsonSchema = z.toJSONSchema(AutomationRunCauseSchema) as {
      anyOf?: Array<{ additionalProperties?: boolean }>;
    };

    expect(jsonSchema.anyOf).toHaveLength(5);
    expect(jsonSchema.anyOf?.every((arm) => arm.additionalProperties === false)).toBe(true);
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
