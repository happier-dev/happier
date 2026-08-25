import { describe, expect, it } from 'vitest';

import {
  AutomationSourceSelectorIdV1JsonSchema as DeclaredAutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema as DeclaredAutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import { MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES } from './automationEventJsonBoundsV1.js';
import {
  AutomationOccurrenceEvidenceEqualityTagV1Schema,
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
  eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
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
    expect(DeclaredAutomationSourceSelectorIdV1Schema.safeParse(
      eventOccurrence.sourceSelectorId,
    ).success).toBe(true);
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
    expect(deriveAutomationOccurrenceKeyV1(spaced))
      .not.toBe(deriveAutomationOccurrenceKeyV1(plain));
  });

  it('uses one length-delimited, domain-separated occurrence identity while preserving payload equality evidence', () => {
    const sameIdentityDifferentPayload = {
      ...eventOccurrence,
      payload: { issue: { number: 43 }, action: 'opened' },
    } as const;

    expect(deriveAutomationOccurrenceKeyV1(eventOccurrence))
      .toBe(deriveAutomationOccurrenceKeyV1(sameIdentityDifferentPayload));
    expect(serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: 'automation-1',
      occurrenceKey: deriveAutomationOccurrenceKeyV1(eventOccurrence),
      evidence: eventOccurrence,
    })).not.toBe(serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: 'automation-1',
      occurrenceKey: deriveAutomationOccurrenceKeyV1(sameIdentityDifferentPayload),
      evidence: sameIdentityDifferentPayload,
    }));
  });

  it('binds E2EE equality tags to the Account, Automation, and exact occurrence key', () => {
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(eventOccurrence);
    const tag = deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-1',
      automationId: 'automation-1',
      occurrenceKey,
      evidence: eventOccurrence,
    });

    expect(AutomationOccurrenceEvidenceEqualityTagV1Schema.parse(tag)).toBe(tag);
    expect(tag).toHaveLength(43);
    expect(tag).not.toBe(deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-2',
      automationId: 'automation-1',
      occurrenceKey,
      evidence: eventOccurrence,
    }));
    expect(tag).not.toBe(deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-1',
      automationId: 'automation-2',
      occurrenceKey,
      evidence: eventOccurrence,
    }));
  });

  it('refuses an equality proof whose supplied occurrence key does not belong to its immutable evidence', () => {
    const otherOccurrenceKey = deriveAutomationOccurrenceKeyV1({
      ...eventOccurrence,
      occurrenceId: 'github-event-43',
    });

    expect(() => serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: 'automation-1',
      occurrenceKey: otherOccurrenceKey,
      evidence: eventOccurrence,
    })).toThrow('occurrence key');
    expect(() => deriveAutomationOccurrenceEvidenceEqualityTagV1({
      purposeSeparatedAccountKey: new Uint8Array(32).fill(7),
      accountId: 'account-1',
      automationId: 'automation-1',
      occurrenceKey: otherOccurrenceKey,
      evidence: eventOccurrence,
    })).toThrow('occurrence key');
  });

  it('uses the canonical non-normalizing Automation identity in equality inputs', () => {
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(eventOccurrence);

    expect(() => serializeAutomationOccurrenceEvidenceEqualityV1({
      accountId: 'account-1',
      automationId: ' automation-1 ',
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
      ...eventOccurrence,
      sourceSelectorId: 'not-a-selector',
    })).toThrow();
    expect(AutomationOccurrenceEvidenceEqualityTagV1Schema.safeParse('A'.repeat(42)).success)
      .toBe(false);
    expect(AutomationOccurrenceEvidenceEqualityTagV1Schema.safeParse('A'.repeat(43) + '=').success)
      .toBe(false);
  });
});
