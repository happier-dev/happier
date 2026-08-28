import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
} from '../../runtime/index.js';
import {
  HOST_EVENT_CATALOG_V1,
  HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
  type HostEventEnvelopeV1,
  type HostEventPayloadByIdV1,
  type HostEventTargetV1,
  HostEventTargetV1Schema,
  parseHostEventPayloadV1,
} from './hostV1.js';

describe('Host Events V1 catalog', () => {
  it('is the exhaustive literal union of the canonical Agent session runtime event producer', () => {
    const expected = AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.map(
      (kind) => `@happier/runtime/${kind}`,
    );

    expect(HOST_EVENT_CATALOG_V1.map((entry) => entry.id)).toEqual([
      ...expected,
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
    ]);
    expect(new Set(HOST_EVENT_CATALOG_V1.map((entry) => entry.id)).size).toBe(expected.length + 1);
    expect(HOST_EVENT_CATALOG_V1).toHaveLength(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.length + 1);
    const runtimeEntries = HOST_EVENT_CATALOG_V1.filter((entry) => entry.id.startsWith('@happier/runtime/'));
    expect(runtimeEntries.every((entry) => (
      entry.canonicalProducer === 'centralized-host-session-runtime'
      && entry.privacy === 'session'
      && entry.realm === 'daemon'
      && entry.disposition === 'public'
      && entry.allowedScopes.join(',') === 'current-session,session'
      && entry.sourceProducers.join(',') === 'agent-session-runtime-event'
    ))).toBe(true);
    expect(HOST_EVENT_CATALOG_V1.filter((entry) => entry.sourceProducers.includes('agent-session-runtime-event')))
      .toHaveLength(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.length);
    expect(HOST_EVENT_CATALOG_V1.find((entry) => (
      entry.id === HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1
    ))).toMatchObject({
      canonicalProducer: 'automation-run-transition',
      sourceProducers: ['automation-run-transition'],
      payloadType: 'AutomationRunStateChangedHostEventV1',
      privacy: 'account',
      allowedScopes: ['account'],
      realm: 'daemon',
      disposition: 'public',
    });
  });

  it('keeps provider-native host event bags outside the public semantic catalog', () => {
    const ids = new Set(HOST_EVENT_CATALOG_V1.map((entry) => entry.id));
    expect(ids.has('@happier/session/provider-hook')).toBe(false);
    expect(ids.has('@happier/session/provider-transcript')).toBe(false);
  });

  it('strictly validates canonical overlap payloads and representative Agent-only payloads', () => {
    const payload = {
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 2,
      kind: 'turn-complete',
      turnId: 'turn-1',
    } as const;
    expect(parseHostEventPayloadV1('@happier/runtime/turn-complete', payload)).toEqual(payload);
    expect(() => parseHostEventPayloadV1('@happier/runtime/turn-complete', {
      ...payload,
      unexpected: true,
    })).toThrow();

    const agentOnlyPayload = {
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 3,
      kind: 'runtime-activity-snapshot',
      state: 'idle',
      activeCount: 0,
    } as const;
    expect(parseHostEventPayloadV1(
      '@happier/runtime/runtime-activity-snapshot',
      agentOnlyPayload,
    )).toEqual(agentOnlyPayload);

    const unknownCompactionPayload = {
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 4,
      kind: 'context-compaction',
      compactionId: 'compaction-1',
      trigger: 'manual',
      phase: 'outcomeUnknown',
      diagnostic: { code: 'compaction_outcome_unknown', severity: 'warning' },
    } as const;
    expect(parseHostEventPayloadV1(
      '@happier/runtime/context-compaction',
      unknownCompactionPayload,
    )).toEqual(unknownCompactionPayload);

    const runtimeEndedPayload = {
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 5,
      kind: 'runtime-ended',
      cause: 'providerEnded',
      retryable: false,
    } as const;
    expect(parseHostEventPayloadV1('@happier/runtime/runtime-ended', runtimeEndedPayload))
      .toEqual(runtimeEndedPayload);
    expect(() => parseHostEventPayloadV1('@happier/runtime/runtime-ended', {
      ...runtimeEndedPayload,
      unexpected: true,
    })).toThrow();
  });

  it('rejects unknown ids and unauthorized host-global targets', () => {
    expect(HostEventTargetV1Schema.safeParse({
      eventId: '@happier/runtime/turn-complete',
      scope: { kind: 'session', sessionId: 'session-1' },
    }).success).toBe(true);
    expect(HostEventTargetV1Schema.safeParse({
      eventId: '@happier/runtime/turn-complete',
      scope: { kind: 'host' },
    }).success).toBe(false);
    expect(HostEventTargetV1Schema.safeParse({
      eventId: '@happier/runtime/not-real',
      scope: { kind: 'current-session' },
    }).success).toBe(false);
  });

  it('owns the exact nonsecret Automation lifecycle payload and only its Account target', () => {
    const payload = {
      runId: 'run-1',
      automationId: 'automation-1',
      runCause: {
        kind: 'trigger',
        triggerId: 'trigger-plugin-event-1',
        triggerRevision: 2,
        triggerKind: 'pluginEvent',
        occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        occurredAt: 1,
        evidence: {
          eventRef: {
            pluginId: 'com.example.automation-events',
            localId: 'issue-opened-v1',
          },
          sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
        },
      },
      previousState: 'queued',
      currentState: 'claimed',
      transitionedAt: 1,
      claimedByMachineId: 'machine-1',
    } as const;

    expect(parseHostEventPayloadV1(
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      payload,
    )).toEqual(payload);
    expect(() => parseHostEventPayloadV1(
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      { ...payload, accountId: 'must-not-leak' },
    )).toThrow();
    expect(() => parseHostEventPayloadV1(
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      { ...payload, runCause: { kind: 'unknown' } },
    )).toThrow();
    expect(parseHostEventPayloadV1(
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      { ...payload, previousState: null, currentState: 'queued' },
    )).toEqual({ ...payload, previousState: null, currentState: 'queued' });
    expect(() => parseHostEventPayloadV1(
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      { ...payload, previousState: null, currentState: 'claimed' },
    )).toThrow();
    expect(() => parseHostEventPayloadV1(
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      { ...payload, currentState: 'queued' },
    )).toThrow();
    expect(HostEventTargetV1Schema.safeParse({
      eventId: HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      scope: { kind: 'account' },
    }).success).toBe(true);
    expect(HostEventTargetV1Schema.safeParse({
      eventId: HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      scope: { kind: 'account', accountId: 'must-not-be-author-supplied' },
    }).success).toBe(false);
    expect(HostEventTargetV1Schema.safeParse({
      eventId: '@happier/runtime/turn-complete',
      scope: { kind: 'account' },
    }).success).toBe(false);
  });

  it('keeps default Host Event target and envelope types correlated by event id', () => {
    type RuntimeAccountTarget = Readonly<{
      eventId: '@happier/runtime/turn-complete';
      scope: Readonly<{ kind: 'account' }>;
    }>;
    type RuntimeAccountEnvelope = Readonly<{
      eventId: '@happier/runtime/turn-complete';
      scope: Readonly<{ kind: 'account' }>;
      payload: HostEventPayloadByIdV1['@happier/runtime/turn-complete'];
    }>;

    expectTypeOf<Readonly<{
      eventId: '@happier/automation/run-state-changed';
      scope: Readonly<{ kind: 'account' }>;
    }>>().toMatchTypeOf<HostEventTargetV1>();
    expectTypeOf<RuntimeAccountTarget>().not.toMatchTypeOf<HostEventTargetV1>();
    expectTypeOf<RuntimeAccountEnvelope>().not.toMatchTypeOf<HostEventEnvelopeV1>();
  });
});
