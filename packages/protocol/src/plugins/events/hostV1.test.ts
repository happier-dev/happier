import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
} from '../../runtime/index.js';
import {
  AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
  AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1,
  AutomationRunStateChangedHostEventV1Schema,
  HOST_EVENT_CATALOG_V1,
  HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
  isAuthoritativeAutomationRunCancellationCauseV1,
  type HostEventEnvelopeV1,
  type HostEventPayloadByIdV1,
  type HostEventTargetV1,
  HostEventTargetV1Schema,
  parseHostEventPayloadV1,
} from './hostV1.js';

describe('Host Events V1 catalog', () => {
  it('admits only an Account-scoped content-free Automation source invalidation', () => {
    const eventId = '@happier/automation/event-sources-invalidated';
    expect(HostEventTargetV1Schema.safeParse({ eventId, scope: { kind: 'account' } }).success).toBe(true);
    expect(HostEventTargetV1Schema.safeParse({ eventId, scope: { kind: 'session', sessionId: 'session-1' } }).success).toBe(false);
    expect(parseHostEventPayloadV1(eventId, {})).toEqual({});
    expect(parseHostEventPayloadV1(eventId, { definitionsChanged: false })).toEqual({ definitionsChanged: false });
    expect(() => parseHostEventPayloadV1(eventId, { definitionsChanged: 'false' })).toThrow();
    expect(() => parseHostEventPayloadV1(eventId, { sourceConfig: {} })).toThrow();
  });

  it('is the exhaustive literal union of the canonical Agent session runtime event producer', () => {
    const expected = AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.map(
      (kind) => `@happier/runtime/${kind}`,
    );

    expect(HOST_EVENT_CATALOG_V1.map((entry) => entry.id)).toEqual([
      ...expected,
      HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      '@happier/automation/event-sources-invalidated',
    ]);
    expect(new Set(HOST_EVENT_CATALOG_V1.map((entry) => entry.id)).size).toBe(expected.length + 2);
    expect(HOST_EVENT_CATALOG_V1).toHaveLength(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.length + 2);
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

describe('authoritative Automation Run cancellation causes', () => {
  it('recognizes exactly the causes that mean the present user cancelled this Run', () => {
    expect(isAuthoritativeAutomationRunCancellationCauseV1(
      AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
    )).toBe(true);
    // Session targets keep no dispatch vocabulary, so their running
    // cancellation carries its own cause. A reader that only knew the
    // dispatch cause would silently downgrade the user's intent to a stale
    // attempt and never discard the exact Automation input.
    expect(isAuthoritativeAutomationRunCancellationCauseV1(
      AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1,
    )).toBe(true);
    expect(AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1)
      .not.toBe(AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1);
  });

  it('treats an absent or unknown bounded cause as non-authoritative', () => {
    expect(isAuthoritativeAutomationRunCancellationCauseV1(undefined)).toBe(false);
    expect(isAuthoritativeAutomationRunCancellationCauseV1('someLaterProducerCause')).toBe(false);
  });

  it('keeps every authoritative cause inside the bounded transition-cause wire bound', () => {
    for (const cause of [
      AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
      AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1,
    ]) {
      expect(AutomationRunStateChangedHostEventV1Schema.safeParse({
        runId: 'run-1',
        automationId: 'automation-1',
        runCause: { kind: 'manual', invokedAt: 1 },
        previousState: 'running',
        currentState: 'outcome_uncertain',
        transitionedAt: 1,
        claimedByMachineId: 'machine-1',
        transitionCause: cause,
      }).success).toBe(true);
    }
  });
});
