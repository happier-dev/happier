import { describe, expect, it } from 'vitest';

import {
  AutomationSourceSelectorIdV1JsonSchema as DeclaredAutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema as DeclaredAutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import { MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES } from './automationEventJsonBoundsV1.js';
import {
  AutomationOccurrenceEvidenceEqualityTagV1Schema,
  AutomationSessionLifecycleOccurrenceEvidenceV1Schema,
  AutomationManualIdempotencyKeyV1Schema,
  AutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema,
  buildAutomationPluginEventOccurrenceEvidenceV1,
  deriveAutomationOccurrenceEvidenceEqualityTagV1,
  deriveAutomationOccurrenceKeyV1,
  deriveAutomationManualOccurrenceKeyV1,
  serializeAutomationOccurrenceEvidenceEqualityV1,
} from './automationOccurrenceV1.js';

const eventOccurrence = {
  v: 1,
  kind: 'pluginEvent',
  eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
  occurrenceId: 'github-event-42',
  occurredAt: 1_714_000_000_000,
  payload: { action: 'opened', issue: { number: 42 } },
} as const;

const conversationOccurrence = {
  v: 1,
  kind: 'conversation',
  bindingId: 'binding-1',
  occurrenceId: 'slack:event:1',
  occurredAt: 1_714_000_000_000,
  caller: {
    pluginId: 'com.acme.slack-bridge',
    contributionLocalId: 'slack/observation-ingest-v1',
    machineId: 'machine-1',
  },
  input: { sender: { id: 'U-1' }, text: 'Summarize the latest change.' },
  replyContextIdentity: 'reply-context-1',
} as const;

describe('Automation occurrence V1', () => {
  it('scopes automatic occurrence identity to the stable trigger id', () => {
    const evidence = buildAutomationPluginEventOccurrenceEvidenceV1(eventOccurrence);

    const first = deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-1', evidence });
    expect(deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-1', evidence })).toBe(first);
    expect(deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-2', evidence })).not.toBe(first);
  });

  it('derives schedule replay and fan-out identity from trigger plus due instant', () => {
    const evidence = { v: 1 as const, kind: 'schedule' as const, scheduledFor: 1_714_000_000_000 };
    const first = deriveAutomationOccurrenceKeyV1({ triggerId: 'schedule-a', evidence });
    expect(first).toHaveLength(43);
    expect(deriveAutomationOccurrenceKeyV1({ triggerId: 'schedule-a', evidence })).toBe(first);
    expect(deriveAutomationOccurrenceKeyV1({ triggerId: 'schedule-b', evidence })).not.toBe(first);
    expect(deriveAutomationOccurrenceKeyV1({
      triggerId: 'schedule-a',
      evidence: { ...evidence, scheduledFor: evidence.scheduledFor + 60_000 },
    })).not.toBe(first);
  });

  it('derives exact-turn occurrence identity from the stable trigger and source turn', () => {
    const evidence = AutomationSessionLifecycleOccurrenceEvidenceV1Schema.parse({
      v: 1,
      kind: 'sessionLifecycle',
      event: 'parentTurnCompleted',
      sourceSessionId: 'session-source-1',
      sourceTurnId: 'turn-7',
      occurredAt: 1_714_000_000_000,
    });
    const key = deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-1', evidence });

    expect(deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: { ...evidence, occurredAt: evidence.occurredAt + 1 },
    })).toBe(key);
    expect(deriveAutomationOccurrenceKeyV1({ triggerId: 'trigger-2', evidence })).not.toBe(key);
    expect(deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: { ...evidence, sourceTurnId: 'turn-8' },
    })).not.toBe(key);
  });
  it('normalizes and bounds the shared manual idempotency contract by UTF-8 bytes', () => {
    expect(AutomationManualIdempotencyKeyV1Schema.parse('  ci-build-42  '))
      .toBe('ci-build-42');
    expect(AutomationManualIdempotencyKeyV1Schema.safeParse('é'.repeat(96)).success)
      .toBe(false);
    expect(AutomationManualIdempotencyKeyV1Schema.safeParse('e\u0301').success)
      .toBe(false);
  });

  it('namespaces a Conversation occurrence by its owning plugin, mirroring Plugin Events', () => {
    const own = deriveAutomationOccurrenceKeyV1(conversationOccurrence);
    // Two plugins observing the same binding and occurrence id must not
    // collide onto one Run, exactly as two Event plugins do not.
    const otherPlugin = deriveAutomationOccurrenceKeyV1({
      ...conversationOccurrence,
      caller: { ...conversationOccurrence.caller, pluginId: 'com.acme.teams-bridge' },
    });
    expect(own).not.toBe(otherPlugin);
    // Rejoin identity still excludes the facts that legitimately move: the
    // admitting machine, the admitting contribution, and the reply context.
    expect(deriveAutomationOccurrenceKeyV1({
      ...conversationOccurrence,
      caller: { ...conversationOccurrence.caller, machineId: 'machine-2' },
      replyContextIdentity: 'reply-context-2',
    })).toBe(own);
    expect(deriveAutomationOccurrenceKeyV1({
      ...conversationOccurrence,
      bindingId: 'binding-2',
    })).not.toBe(own);
  });

  it('derives stable, automation-scoped identities for retried manual occurrences', () => {
    const first = deriveAutomationManualOccurrenceKeyV1({
      automationId: 'automation-1',
      idempotencyKey: 'ci-build-42',
    });
    expect(first).toHaveLength(43);
    expect(first).toBe(deriveAutomationManualOccurrenceKeyV1({
      automationId: 'automation-1',
      idempotencyKey: 'ci-build-42',
    }));
    expect(first).not.toBe(deriveAutomationManualOccurrenceKeyV1({
      automationId: 'automation-2',
      idempotencyKey: 'ci-build-42',
    }));
    expect(first).not.toBe(deriveAutomationManualOccurrenceKeyV1({
      automationId: 'automation-1',
      idempotencyKey: 'ci-build-43',
    }));
  });

  it('uses the Event declaration owner for source-selector identity', () => {
    expect(AutomationSourceSelectorIdV1Schema).toBe(DeclaredAutomationSourceSelectorIdV1Schema);
    expect(AutomationSourceSelectorIdV1JsonSchema)
      .toBe(DeclaredAutomationSourceSelectorIdV1JsonSchema);
    expect(DeclaredAutomationSourceSelectorIdV1Schema.parse(
      eventOccurrence.sourceSelectorId,
    )).toBe(eventOccurrence.sourceSelectorId);
  });

  it('builds the one canonical Plugin Event evidence shape from Event admission semantics', () => {
    expect(buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef: eventOccurrence.eventRef,
      sourceSelectorId: eventOccurrence.sourceSelectorId,
      occurrenceId: eventOccurrence.occurrenceId,
      occurredAt: eventOccurrence.occurredAt,
      payload: eventOccurrence.payload,
    })).toEqual(eventOccurrence);
  });

  it('preserves surrounding whitespace in publicly distinct occurrence identities', () => {
    const plain = buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef: eventOccurrence.eventRef,
      sourceSelectorId: eventOccurrence.sourceSelectorId,
      occurrenceId: 'provider-occurrence-1',
      occurredAt: eventOccurrence.occurredAt,
      payload: eventOccurrence.payload,
    });
    const spaced = buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef: eventOccurrence.eventRef,
      sourceSelectorId: eventOccurrence.sourceSelectorId,
      occurrenceId: ' provider-occurrence-1 ',
      occurredAt: eventOccurrence.occurredAt,
      payload: eventOccurrence.payload,
    });

    expect(spaced.occurrenceId).toBe(' provider-occurrence-1 ');
    expect(deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: spaced,
    })).not.toBe(deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: plain,
    }));
  });

  it('uses one length-delimited, domain-separated occurrence identity while preserving payload equality evidence', () => {
    const sameIdentityDifferentPayload = {
      ...eventOccurrence,
      payload: { issue: { number: 43 }, action: 'opened' },
    } as const;

    expect(deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: eventOccurrence,
    })).toBe(deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: sameIdentityDifferentPayload,
    }));
    expect(serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      occurrenceKey: deriveAutomationOccurrenceKeyV1({
        triggerId: 'trigger-1',
        evidence: eventOccurrence,
      }),
      evidence: eventOccurrence,
    })).not.toBe(serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      occurrenceKey: deriveAutomationOccurrenceKeyV1({
        triggerId: 'trigger-1',
        evidence: sameIdentityDifferentPayload,
      }),
      evidence: sameIdentityDifferentPayload,
    }));
  });

  it('binds E2EE equality tags to the Account, Automation, and exact occurrence key', () => {
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: eventOccurrence,
    });
    const tag = deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-1',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      occurrenceKey,
      evidence: eventOccurrence,
    });

    expect(AutomationOccurrenceEvidenceEqualityTagV1Schema.parse(tag)).toBe(tag);
    expect(tag).toHaveLength(43);
    expect(tag).not.toBe(deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-2',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      occurrenceKey,
      evidence: eventOccurrence,
    }));
    expect(tag).not.toBe(deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-1',
      automationId: 'automation-2',
      triggerId: 'trigger-1',
      occurrenceKey,
      evidence: eventOccurrence,
    }));
  });

  it('refuses an equality proof whose supplied occurrence key does not belong to its immutable evidence', () => {
    const otherOccurrenceKey = deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: {
        ...eventOccurrence,
        occurrenceId: 'github-event-43',
      },
    });

    expect(() => serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      occurrenceKey: otherOccurrenceKey,
      evidence: eventOccurrence,
    })).toThrow('occurrence key');
    expect(() => deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-1',
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      occurrenceKey: otherOccurrenceKey,
      evidence: eventOccurrence,
    })).toThrow('occurrence key');
  });

  it('uses the canonical non-normalizing Automation identity in equality inputs', () => {
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: eventOccurrence,
    });

    expect(() => serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: ' automation-1 ',
      triggerId: 'trigger-1',
      occurrenceKey,
      evidence: eventOccurrence,
    })).toThrow();
  });

  it('admits occurrence-evidence payloads under the canonical Event payload bound', () => {
    const oversizedPayload = {
      blob: 'a'.repeat(MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES),
    };
    expect(() => buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef: eventOccurrence.eventRef,
      sourceSelectorId: eventOccurrence.sourceSelectorId,
      occurrenceId: eventOccurrence.occurrenceId,
      occurredAt: eventOccurrence.occurredAt,
      payload: oversizedPayload,
    })).toThrow();
  });

  it('rejects noncanonical selectors and malformed E2EE equality tags', () => {
    expect(() => deriveAutomationOccurrenceKeyV1({
      triggerId: 'trigger-1',
      evidence: { ...eventOccurrence, sourceSelectorId: 'not-a-selector' },
    })).toThrow();
    expect(AutomationOccurrenceEvidenceEqualityTagV1Schema.safeParse('A'.repeat(42)).success)
      .toBe(false);
    expect(AutomationOccurrenceEvidenceEqualityTagV1Schema.safeParse('A'.repeat(43) + '=').success)
      .toBe(false);
  });
});
