import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

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

    expect(jsonSchema.anyOf?.length).toBeGreaterThan(0);
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

  it('accepts only corresponding public Machine presence evidence', () => {
    const cause = {
      kind: 'trigger', triggerId: 'presence-trigger', triggerRevision: 1, triggerKind: 'pluginEvent',
      occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', occurredAt: 1_700_000_000_000,
      evidence: {
        eventRef: { pluginId: 'happier.machine.services', localId: 'machine-offline' },
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
        serverOccurrence: { kind: 'machinePresence', payload: { serverId: 'srv_presenceCause1', machineId: 'machine-1',
          transition: 'offline', revision: 1, observedAt: 1_700_000_000_000 } },
      },
    };
    expect(AutomationRunCauseSchema.parse(cause)).toEqual(cause);
    const { serverId: _unavailableHome, ...unqualifiedPayload } = cause.evidence.serverOccurrence.payload;
    const unqualified = { ...cause, evidence: { ...cause.evidence,
      serverOccurrence: { ...cause.evidence.serverOccurrence, payload: unqualifiedPayload } } };
    expect(AutomationRunCauseSchema.parse(unqualified)).toEqual(unqualified);
    for (const eventRef of [
      { pluginId: 'other.plugin', localId: 'machine-offline' },
      { pluginId: 'happier.machine.services', localId: 'machine-online' },
    ]) {
      expect(AutomationRunCauseSchema.safeParse({ ...cause, evidence: { ...cause.evidence, eventRef } }).success).toBe(false);
    }
    expect(AutomationRunCauseSchema.safeParse({ ...cause, occurredAt: cause.occurredAt + 1 }).success).toBe(false);
    expect(AutomationRunCauseSchema.safeParse({ ...cause, evidence: { ...cause.evidence,
      serverOccurrence: { ...cause.evidence.serverOccurrence, payload: { ...cause.evidence.serverOccurrence.payload,
        privateInput: 'forbidden' } } } }).success).toBe(false);
  });

  it('freezes the actual lifecycle Event and occurrence policy without request content', () => {
    const cause = AutomationRunCauseSchema.parse({
      kind: 'trigger',
      triggerId: 'trigger-lifecycle',
      triggerRevision: 4,
      triggerKind: 'sessionLifecycle',
      occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      occurredAt: 1_700_000_000_000,
      evidence: {
        event: 'userActionRequired',
        sourceSessionId: 'source-session',
        sourceTurnId: 'source-turn',
        requestId: 'request-1',
        requestKind: 'user_action',
        policy: { kind: 'nextMatches', count: 3 },
      },
    });

    expect(cause).toMatchObject({
      triggerKind: 'sessionLifecycle',
      evidence: {
        event: 'userActionRequired',
        requestId: 'request-1',
        policy: { kind: 'nextMatches', count: 3 },
      },
    });
    expect(cause.evidence).not.toHaveProperty('request');
  });
});
