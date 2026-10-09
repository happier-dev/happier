import { describe, expect, it } from 'vitest';
import * as protocol from './managedIntentV1.js';

describe('managed intent transport admission', () => {
  it('requires the explicit reviewed rebuild specialization instead of a generic immediate native command', () => {
    const schema = Reflect.get(protocol, 'DevcontainerRebuildIntentV1Schema');
    const intent = { managedMachineId: 'managed', expectedRevision: 4, kind: 'rebuild', reviewedEffectDigest: 'reviewed-config' };
    expect(schema?.safeParse(intent).success).toBe(true);
    expect(schema?.safeParse({ ...intent, actorAccountId: 'forged' }).success).toBe(false);
    expect(schema?.safeParse({ ...intent, reviewedEffectDigest: '' }).success).toBe(false);
    expect(protocol.ManagedIntentInputSchema.safeParse({ homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 4, intent: 'rebuild' }).success).toBe(false);
  });
  it('requires revision for immediate effects, and admits only revision-free stop/delete after idle', () => {
    const schema = Reflect.get(protocol, 'ManagedIntentInputSchema');
    expect(schema).toBeDefined();
    const target = { homeId: 'home', managedId: 'managed' };
    expect(schema.safeParse({ ...target, when: 'now', expectedRevision: 4, intent: 'stop' }).success).toBe(true);
    expect(schema.safeParse({ ...target, when: 'now', intent: 'stop' }).success).toBe(false);
    expect(schema.safeParse({ ...target, when: 'now', expectedRevision: 4, intent: 'stop', afterMs: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...target, when: 'after-idle', intent: 'delete', afterMs: 3_600_000 }).success).toBe(true);
    expect(schema.safeParse({ ...target, when: 'after-idle', intent: 'stop' }).success).toBe(true);
    for (const extra of [{ expectedRevision: 4 }, { afterMs: -1 }, { actorAccountId: 'forged' }]) {
      expect(schema.safeParse({ ...target, when: 'after-idle', intent: 'stop', ...extra }).success).toBe(false);
    }
    expect(schema.safeParse({ ...target, when: 'after-idle', intent: 'start' }).success).toBe(false);
  });

  it('transports only content-free activity decisions and strict outcomes', () => {
    const decision = Reflect.get(protocol, 'ActivityDecisionV1Schema');
    const result = Reflect.get(protocol, 'ManagedIntentResultSchema');
    expect(decision).toBeDefined();
    expect(result).toBeDefined();
    expect(decision.safeParse({ kind: 'idle', since: 0 }).success).toBe(true);
    expect(decision.safeParse({ kind: 'unknown', reasons: ['coverage_unknown'] }).success).toBe(true);
    expect(decision.safeParse({ kind: 'busy', reasons: ['session'], sessionId: 'private' }).success).toBe(false);
    expect(decision.safeParse({ kind: 'busy', reasons: ['private session name'] }).success).toBe(false);
    expect(result.safeParse({ kind: 'conflict', currentRevision: 4 }).success).toBe(true);
    expect(result.safeParse({ kind: 'accepted', managedId: 'managed', intentRevision: 5,
      operation: { operationId: 'op' } }).success).toBe(true);
    expect(result.safeParse({ kind: 'accepted', managedId: 'managed', intentRevision: 5,
      operation: { operationId: 'op' }, stopped: true }).success).toBe(false);
  });
});
