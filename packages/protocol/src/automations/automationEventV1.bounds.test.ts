import { describe, expect, it } from 'vitest';

import { AUTOMATION_INT_COLUMN_MAX } from './automationColumnBoundsV1.js';
import { AutomationEventPositiveSafeIntegerV1Schema } from './automationEventDeclarationV1.js';
import { AutomationPluginEventTriggerSchema } from './automationApiV3.js';

import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import {
  buildAutomationPluginEventOccurrenceEvidenceV1,
  deriveAutomationOccurrenceKeyV1,
} from './automationOccurrenceV1.js';
import {
  AutomationConversationAdmitInputV1Schema,
  AutomationEventActionHttpRequestSchemasV1,
  AutomationEventAdmitHttpInputV1Schema,
  AutomationEventAdmitHttpResultV1Schema,
  AutomationEventAdmitInputV1Schema,
  AutomationEventAdmitResultV1Schema,
  AutomationEventFilterV1Schema,
  AutomationEventSourceDefinitionV1Schema,
  AutomationEventSourcesListInputV1Schema,
  AutomationEventSourcesListResultV1Schema,
  AutomationResultDeliveryInputV1Schema,
  AutomationResultDeliveryInputV1JsonSchema,
  AutomationResultDeliveryResultV1Schema,
  AutomationResultDeliverySourceV1JsonSchema,
  AutomationRunResultStoredV1Schema,
  AutomationRunResultV1Schema,
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_CONVERSATION_ADMIT_TEXT_UTF8_BYTES,
  MAX_AUTOMATION_EVENT_FILTER_CLAUSES,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
  MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
  MAX_AUTOMATION_EVENT_FILTER_IN_VALUES,
  MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS,
  MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
  MAX_AUTOMATION_REPLY_CONTEXT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_CONFIG_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS,
  MAX_AUTOMATION_SOURCE_OR_OCCURRENCE_ID_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
  PluginEventAutomationSetupResultV1Schema,
  readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1,
} from './automationEventV1.js';
import {
  PluginEventAutomationSetupResultV1Schema as portablePluginEventAutomationSetupResultV1Schema,
} from './automationEventSetupResultV1.js';

const sourceSelectorId = '9d5af559-2c82-4c22-b6a0-ecabce38a631';

function jsonStringAtCanonicalByteLimit(
  schemaPrefix: Readonly<Record<string, unknown>>,
  field: string,
  limit: number,
): string {
  const empty = JSON.stringify({ ...schemaPrefix, [field]: '' });
  return 'x'.repeat(limit - new TextEncoder().encode(empty).byteLength);
}

function sourceDefinition(index: number) {
  return {
    automationId: `automation-${index}`,
    triggerId: `trigger-${index}`,
    triggerRevision: 1,
    eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
    sourceInstanceId: `repository-${index}`,
    sourceSelectorId,
    sourceContractVersion: 1,
    sourceConfig: {},
    observationTransport: {
      kind: 'checkpointedPull' as const,
      watcherMaterializationRef: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'com.acme.github',
      },
    },
    filter: null,
    maximumObservationAgeMs: null,
  };
}

function admitInput(payload: unknown, occurrenceId = 'occurrence-1') {
  return {
    eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
    occurrenceId,
    occurredAt: 1,
    observationReceivedAt: 2,
    payload,
    definitions: [{
      automationId: 'automation-1',
      triggerId: 'trigger-1',
      triggerRevision: 1,
      sourceSelectorId,
    }],
  };
}

describe('Automation event V1 exact bounds', () => {
  it('projects the setup result through the portable Automation Event leaf', async () => {
    const [automationEventV1, automationEventSetupResultV1] = await Promise.all([
      import('./automationEventV1.js'),
      import('./automationEventSetupResultV1.js'),
    ]);
    const setupResult = {
      v: 1,
      sourceInstanceId: 'repository-1',
      sourceContractVersion: 1,
      sourceConfig: { repository: 'acme/widgets' },
      displayLabel: 'Repository',
    };

    expect(automationEventV1.PluginEventAutomationSetupResultV1Schema)
      .toBe(automationEventSetupResultV1.PluginEventAutomationSetupResultV1Schema);
    expect(PluginEventAutomationSetupResultV1Schema)
      .toBe(portablePluginEventAutomationSetupResultV1Schema);
    expect(automationEventSetupResultV1.PluginEventAutomationSetupResultV1Schema.safeParse(setupResult).success)
      .toBe(true);
  });

  it('accepts the portable source-time maximum and rejects later Event and Conversation facts', () => {
    const maxPortableOccurredAt = 253_402_300_799_999;
    const conversation = {
      automationId: 'automation-1',
      bindingId: 'binding-1',
      templateVersion: 1,
      occurrenceId: 'occurrence-1',
      occurredAt: maxPortableOccurredAt,
      sender: {},
      text: '',
      resultDelivery: {
        kind: 'finalResult',
        actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
        opaqueContext: {},
      },
    };

    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      occurredAt: maxPortableOccurredAt,
    }).success).toBe(true);
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      occurredAt: maxPortableOccurredAt + 1,
    }).success).toBe(false);
    expect(AutomationConversationAdmitInputV1Schema.safeParse(conversation).success).toBe(true);
    expect(AutomationConversationAdmitInputV1Schema.safeParse({
      ...conversation,
      occurredAt: maxPortableOccurredAt + 1,
    }).success).toBe(false);
  });

  it('accepts exact UTF-8 payload/config/source-input maxima and rejects max-plus-one', () => {
    const payloadAtMax = 'x'.repeat(MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES - 2);
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput(payloadAtMax)).success).toBe(true);
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput(`${payloadAtMax}x`)).success).toBe(false);

    const configAtMax = 'x'.repeat(MAX_AUTOMATION_SOURCE_CONFIG_UTF8_BYTES - 2);
    expect(AutomationEventSourceDefinitionV1Schema.safeParse({
      ...sourceDefinition(1),
      sourceConfig: configAtMax,
    }).success).toBe(true);
    expect(AutomationEventSourceDefinitionV1Schema.safeParse({
      ...sourceDefinition(1),
      sourceConfig: `${configAtMax}x`,
    }).success).toBe(false);

    // Pinned to the literal ceilings rather than re-derived from the constants
    // under test: a guard built from the value it asserts cannot catch the
    // constant moving. The sender identity is a resolution input (2 KiB); the
    // conversation body is a Conversation ingress message (64 KiB).
    expect(MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES).toBe(2048);
    expect(MAX_AUTOMATION_CONVERSATION_ADMIT_TEXT_UTF8_BYTES).toBe(65536);

    const senderAtMax = 'x'.repeat(2048 - 2);
    const textAtMax = 'x'.repeat(65536);
    const conversation = {
      automationId: 'automation-1',
      bindingId: 'binding-1',
      templateVersion: 1,
      occurrenceId: 'occurrence-1',
      occurredAt: 1,
      sender: senderAtMax,
      text: textAtMax,
      resultDelivery: {
        kind: 'finalResult',
        actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
        opaqueContext: {},
      },
    };
    expect(AutomationConversationAdmitInputV1Schema.safeParse(conversation).success).toBe(true);
    expect(AutomationConversationAdmitInputV1Schema.safeParse({
      ...conversation,
      sender: `${senderAtMax}x`,
    }).success).toBe(false);
    expect(AutomationConversationAdmitInputV1Schema.safeParse({
      ...conversation,
      text: `${textAtMax}x`,
    }).success).toBe(false);
  });

  it('admits an ordinary long conversation message past the sender-resolution ceiling', () => {
    // Regression: the admit body reused the sender-resolution ceiling, so every
    // channel message over 2 KiB — an ordinary long Telegram/Discord message —
    // failed admission for its whole retry budget and burned into blocked
    // attention. The body's real boundary is the Conversation ingress message.
    const conversation = (text: string) => ({
      automationId: 'automation-1',
      bindingId: 'binding-1',
      templateVersion: 1,
      occurrenceId: 'occurrence-1',
      occurredAt: 1,
      sender: { principalId: 'user-1', kind: 'human', isIntegrationSelf: false },
      text,
      resultDelivery: { kind: 'none' },
    });

    for (const bytes of [2048, 2049, 8192, 65536]) {
      const parsed = AutomationConversationAdmitInputV1Schema.safeParse(
        conversation('x'.repeat(bytes)),
      );
      expect(parsed.success, `${bytes} UTF-8 bytes`).toBe(true);
    }
    expect(AutomationConversationAdmitInputV1Schema.safeParse(
      conversation('x'.repeat(65537)),
    ).success).toBe(false);
    // Multi-byte code points are measured in UTF-8 bytes, not code units.
    expect(AutomationConversationAdmitInputV1Schema.safeParse(
      conversation('é'.repeat(32768)),
    ).success).toBe(true);
    expect(AutomationConversationAdmitInputV1Schema.safeParse(
      conversation('é'.repeat(32769)),
    ).success).toBe(false);
  });

  it('distinguishes NFC code-point limits from UTF-8 byte limits', () => {
    const labelAtMax = '🧪'.repeat(MAX_AUTOMATION_SOURCE_DISPLAY_LABEL_CODE_POINTS);
    const setup = {
      v: 1,
      sourceInstanceId: 'repository-1',
      sourceContractVersion: 1,
      sourceConfig: {},
      displayLabel: labelAtMax,
    };
    expect(PluginEventAutomationSetupResultV1Schema.safeParse(setup).success).toBe(true);
    expect(PluginEventAutomationSetupResultV1Schema.safeParse({
      ...setup,
      displayLabel: `${labelAtMax}🧪`,
    }).success).toBe(false);

    const filterValueAtMax = '🧪'.repeat(MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS);
    expect(AutomationEventFilterV1Schema.safeParse({
      v: 1,
      all: [{ op: 'eq', field: '/value', value: filterValueAtMax }],
    }).success).toBe(true);
    expect(AutomationEventFilterV1Schema.safeParse({
      v: 1,
      all: [{ op: 'eq', field: '/value', value: `${filterValueAtMax}🧪` }],
    }).success).toBe(false);

    const occurrenceIdAtMax = 'é'.repeat(MAX_AUTOMATION_SOURCE_OR_OCCURRENCE_ID_UTF8_BYTES / 2);
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput({}, occurrenceIdAtMax)).success).toBe(true);
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput({}, `${occurrenceIdAtMax}é`)).success).toBe(false);
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput({}, 'e\u0301')).success).toBe(false);
  });

  it('keeps filter cardinality bounded while accepting deep and wide owner-bounded JSON', () => {
    const clausesAtMax = Array.from(
      { length: MAX_AUTOMATION_EVENT_FILTER_CLAUSES },
      (_, index) => ({ op: 'eq' as const, field: `/field-${index}`, value: index }),
    );
    expect(AutomationEventFilterV1Schema.safeParse({ v: 1, all: clausesAtMax }).success).toBe(true);
    expect(AutomationEventFilterV1Schema.safeParse({
      v: 1,
      all: [...clausesAtMax, { op: 'eq', field: '/overflow', value: true }],
    }).success).toBe(false);

    const inValuesAtMax = Array.from(
      { length: MAX_AUTOMATION_EVENT_FILTER_IN_VALUES },
      (_, index) => index,
    );
    expect(AutomationEventFilterV1Schema.safeParse({
      v: 1,
      all: [{ op: 'in', field: '/value', values: inValuesAtMax }],
    }).success).toBe(true);
    expect(AutomationEventFilterV1Schema.safeParse({
      v: 1,
      all: [{ op: 'in', field: '/value', values: [...inValuesAtMax, inValuesAtMax.length] }],
    }).success).toBe(false);

    let deepJson: unknown = null;
    for (let depth = 0; depth < 33; depth += 1) {
      deepJson = [deepJson];
    }
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput(deepJson)).success).toBe(true);
    expect(AutomationEventSourceDefinitionV1Schema.safeParse({
      ...sourceDefinition(1),
      sourceConfig: deepJson,
    }).success).toBe(true);
    expect(AutomationConversationAdmitInputV1Schema.safeParse({
      automationId: 'automation-1',
      bindingId: 'binding-1',
      templateVersion: 1,
      occurrenceId: 'occurrence-1',
      occurredAt: 1,
      sender: deepJson,
      text: '',
      resultDelivery: {
        kind: 'finalResult',
        actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
        opaqueContext: deepJson,
      },
    }).success).toBe(true);

    const wideJson = Array.from({ length: 16_384 }, () => 0);
    expect(AutomationEventAdmitInputV1Schema.safeParse(admitInput(wideJson)).success).toBe(true);
  });

  // Ceiling-sized case: it materializes maximum-bound payloads and measures
  // their canonical UTF-8 transport length. Unloaded on an M-series host the
  // three ceiling cases run 632 ms / 759 ms / 647 ms, but a concurrently
  // loaded fleet measured 4226 ms for this file's slowest case against
  // Vitest's 5 s default. The budget is sized from that ceiling work, not the
  // default, so contention cannot turn a passing bound into a red suite.
  it('keeps source pages, public aggregates, and private admission calls independently bounded', () => {
    const definitionsAtMax = Array.from(
      { length: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE },
      (_, index) => sourceDefinition(index),
    );
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      pageSize: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
    }).success).toBe(true);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      pageSize: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE + 1,
    }).success).toBe(false);
    expect(AutomationEventSourcesListResultV1Schema.safeParse({
      kind: 'page',
      revision: '1',
      definitions: definitionsAtMax,
      nextCursor: null,
    }).success).toBe(true);
    expect(AutomationEventSourcesListResultV1Schema.safeParse({
      kind: 'page',
      revision: '1',
      definitions: [...definitionsAtMax, sourceDefinition(definitionsAtMax.length)],
      nextCursor: null,
    }).success).toBe(false);

    // The semantic Action is the complete adopted snapshot and deliberately
    // has no aggregate definition ceiling. E3 partitions it into the bounded
    // private calls below; retaining the former Account-level 10,000 cap here
    // would reject a valid snapshot before that canonical partitioner runs.
    const definitionsBeyondFormerUnapprovedAggregateLimit = Array.from(
      { length: 10_001 },
      (_, index) => ({
        automationId: `automation-${index}`,
        triggerId: `trigger-${index}`,
        triggerRevision: 1,
        sourceSelectorId,
      }),
    );
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: definitionsBeyondFormerUnapprovedAggregateLimit,
    }).success).toBe(true);
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: [
        ...definitionsBeyondFormerUnapprovedAggregateLimit,
        definitionsBeyondFormerUnapprovedAggregateLimit[0],
      ],
    }).success).toBe(true);

    const admitDefinitionsAtCallMax = definitionsBeyondFormerUnapprovedAggregateLimit.slice(
      0,
      MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
    );
    expect(AutomationEventAdmitHttpInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: admitDefinitionsAtCallMax,
    }).success).toBe(true);
    expect(AutomationEventAdmitHttpInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: [...admitDefinitionsAtCallMax, definitionsBeyondFormerUnapprovedAggregateLimit[15]],
    }).success).toBe(false);

    const actionResultsBeyondFormerLimit = Array.from(
      { length: 10_001 },
      () => ({ kind: 'skipped' as const, reason: 'filtered' as const, checkpointSafe: true as const }),
    );
    expect(AutomationEventAdmitResultV1Schema.safeParse({ results: actionResultsBeyondFormerLimit }).success).toBe(true);
    expect(AutomationEventAdmitResultV1Schema.safeParse({
      results: [...actionResultsBeyondFormerLimit, actionResultsBeyondFormerLimit[0]],
    }).success).toBe(true);

    const callResultsAtMax = actionResultsBeyondFormerLimit.slice(
      0,
      MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
    );
    const readyContinuation = {
      kind: 'ready' as const,
      accountCurrentness: {
        mode: 'plain' as const,
        version: 7,
        contentKeyFingerprint: null,
      },
    };
    expect(AutomationEventAdmitHttpResultV1Schema.safeParse({
      results: callResultsAtMax,
      continuation: readyContinuation,
    }).success).toBe(true);
    expect(AutomationEventAdmitHttpResultV1Schema.safeParse({ results: callResultsAtMax }).success).toBe(false);
    expect(AutomationEventAdmitHttpResultV1Schema.safeParse({
      results: callResultsAtMax,
      continuation: { kind: 'stopped', reason: 'accountCurrentnessMoved' },
    }).success).toBe(true);
    expect(AutomationEventAdmitHttpResultV1Schema.safeParse({
      results: callResultsAtMax,
      continuation: { kind: 'stopped', reason: 'unknown' },
    }).success).toBe(false);
    expect(AutomationEventAdmitHttpResultV1Schema.safeParse({
      results: [...callResultsAtMax, actionResultsBeyondFormerLimit[15]],
      continuation: readyContinuation,
    }).success).toBe(false);
  }, 30_000);

  it('does not invent a result-content ceiling while preserving real reply/legacy/retry bounds', () => {
    const resultTextBeyondFormerCeiling = 'x'.repeat((512 * 1024) + 1);
    expect(AutomationRunResultV1Schema.safeParse({
      v: 1,
      kind: 'text',
      text: resultTextBeyondFormerCeiling,
    }).success).toBe(true);
    expect(AutomationRunResultV1Schema.safeParse({
      v: 1,
      kind: 'sessionInputAccepted',
      sessionId: 'session-1',
      localId: 'local-1',
      admission: 'accepted',
    }).success).toBe(false);

    const replyContextAtMax = jsonStringAtCanonicalByteLimit(
      {},
      'opaqueContext',
      MAX_AUTOMATION_REPLY_CONTEXT_UTF8_BYTES,
    );
    const conversation = {
      automationId: 'automation-1',
      bindingId: 'binding-1',
      templateVersion: 1,
      occurrenceId: 'occurrence-1',
      occurredAt: 1,
      sender: {},
      text: '',
      resultDelivery: {
        kind: 'finalResult',
        actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
        opaqueContext: { opaqueContext: replyContextAtMax },
      },
    };
    expect(AutomationConversationAdmitInputV1Schema.safeParse(conversation).success).toBe(true);
    expect(AutomationConversationAdmitInputV1Schema.safeParse({
      ...conversation,
      resultDelivery: {
        ...conversation.resultDelivery,
        opaqueContext: { opaqueContext: `${replyContextAtMax}x` },
      },
    }).success).toBe(false);

    const plainStoredAtMax = jsonStringAtCanonicalByteLimit(
      { t: 'plain' },
      'v',
      MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
    );
    expect(AutomationStoredContentEnvelopeV1Schema.safeParse({
      t: 'plain',
      v: plainStoredAtMax,
    }).success).toBe(true);
    expect(AutomationStoredContentEnvelopeV1Schema.safeParse({
      t: 'plain',
      v: `${plainStoredAtMax}x`,
    }).success).toBe(false);

    const legacyStoredAtMax = jsonStringAtCanonicalByteLimit(
      { t: 'legacySummaryCiphertext' },
      'c',
      MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
    );
    expect(AutomationRunResultStoredV1Schema.safeParse({
      t: 'legacySummaryCiphertext',
      c: legacyStoredAtMax,
    }).success).toBe(true);
    expect(AutomationRunResultStoredV1Schema.safeParse({
      t: 'legacySummaryCiphertext',
      c: `${legacyStoredAtMax}x`,
    }).success).toBe(false);
    expect(AutomationRunResultStoredV1Schema.safeParse({
      t: 'plain',
      v: {
        v: 1,
        correspondence: {
          accountId: 'account-1',
          automationId: 'automation-1',
          runId: 'run-1',
          handoffId: 'handoff-1',
        },
        result: { v: 1, kind: 'text', text: resultTextBeyondFormerCeiling },
      },
    }).success).toBe(true);

    expect(AutomationResultDeliveryResultV1Schema.safeParse({
      kind: 'retry',
      retryAfterMs: MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
      code: 'temporarilyUnavailable',
    }).success).toBe(true);
    expect(AutomationResultDeliveryResultV1Schema.safeParse({
      kind: 'retry',
      retryAfterMs: MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS + 1,
      code: 'temporarilyUnavailable',
    }).success).toBe(false);
    expect(AutomationResultDeliveryResultV1Schema.safeParse({
      kind: 'retired',
    }).success).toBe(true);
  });

  it('requires one strict immutable source on every final-result delivery input', () => {
    const delivery = {
      v: 1,
      handoffId: 'handoff-1',
      runId: 'run-1',
      automationId: 'automation-1',
      result: { v: 1, kind: 'text', text: 'Completed.' },
      opaqueContext: { route: 'channels' },
    } as const;
    const source = {
      kind: 'automationResult',
      automationRunId: 'run-1',
      resultId: 'handoff-1',
      automationId: 'automation-1',
      resultDelivery: 'finalResult',
    } as const;

    expect(AutomationResultDeliveryInputV1Schema.safeParse(delivery).success).toBe(false);
    expect(AutomationResultDeliveryInputV1Schema.safeParse({ ...delivery, source }).success).toBe(true);
    expect(AutomationResultDeliveryInputV1Schema.safeParse({
      ...delivery,
      source: { ...source, templateVersion: 3 },
    }).success).toBe(false);
    expect(AutomationResultDeliveryInputV1Schema.safeParse({
      ...delivery,
      source: { ...source, resultId: 'other-handoff', extra: true },
    }).success).toBe(false);

    const sourceJson = compilePluginJsonSchema(AutomationResultDeliverySourceV1JsonSchema);
    const inputJson = compilePluginJsonSchema(AutomationResultDeliveryInputV1JsonSchema);
    for (const candidate of [
      source,
      { ...source, resultId: 'other-handoff', extra: true },
      { ...source, automationRunId: ' run-1' },
    ]) {
      expect(sourceJson(candidate)).toBe(
        AutomationResultDeliveryInputV1Schema.safeParse({ ...delivery, source: candidate }).success,
      );
    }
    for (const candidate of [
      delivery,
      { ...delivery, source },
      { ...delivery, source: { ...source, resultId: 'other-handoff', extra: true } },
      {
        ...delivery,
        source,
        result: {
          v: 1,
          kind: 'sessionInputAccepted',
          sessionId: 'session-1',
          localId: 'local-1',
          admission: 'accepted',
        },
      },
    ]) {
      expect(inputJson(candidate)).toBe(AutomationResultDeliveryInputV1Schema.safeParse(candidate).success);
    }
  });

  it('retains the approved 500-definition encrypted Event batch as a logical request when every definition is individually within its stored-content bound', () => {
    const eventRef = { pluginId: 'com.acme.github', localId: 'pull-request-opened' } as const;
    const caller = {
      pluginId: eventRef.pluginId,
      immutableGenerationId: 'generation-1',
      materialization: {
        pluginId: eventRef.pluginId,
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
    } as const;
    const triggerEvidenceEnvelope = {
      t: 'encrypted',
      c: sealAccountScopedBlobCiphertext({
        kind: 'automation_trigger_evidence',
        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
        payload: { v: 1, padding: 'x'.repeat(34 * 1024) },
        randomBytes: (length) => new Uint8Array(length),
      }),
    } as const;
    const occurrenceKey = deriveAutomationOccurrenceKeyV1(
      buildAutomationPluginEventOccurrenceEvidenceV1({
        eventRef,
        sourceSelectorId,
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        payload: { action: 'opened' },
      }),
    );
    // This is deliberately well below the per-definition 512 KiB envelope
    // ceiling. The 500 below is the source-LIST page cardinality
    // (MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE), not an Action
    // cardinality. One private admission call remains capped at 15
    // (MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL), while E3 may
    // partition a complete adopted Action snapshot without an aggregate cap.
    const request = {
      v: 1 as const,
      caller,
      hostEvidence: {
        v: 1 as const,
        t: 'encrypted' as const,
        accountCurrentness: {
          mode: 'e2ee' as const,
          version: 8,
          contentKeyFingerprint: 'aemk1_content_key',
        },
        adoptedRevision: '9',
        eventRef,
        eventDeclarationRelease: {
          release: { pluginId: eventRef.pluginId, version: '1.0.0' },
          archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        },
        definitions: Array.from({ length: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE }, (_, index) => ({
          automationId: `automation-${index}`,
          triggerId: `trigger-${index}`,
          triggerRevision: 1,
          sourceSelectorId,
          sourceContractVersion: 1,
          observationTransport: 'checkpointedPull' as const,
          occurrenceKey,
          occurredAt: 1,
          triggerEvidenceEnvelope,
          occurrenceEvidenceEqualityTag: 'A'.repeat(43),
          outcome: { kind: 'matched' as const },
        })),
      },
    };
    const admit = AutomationEventActionHttpRequestSchemasV1['automation.event.admit'];

    const canonicalBytes = readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(request);
    expect(canonicalBytes)
      .toBeGreaterThan(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES);
    // r0.36 keeps the 500-item source-list page as a read concern, but a
    // private E2 admission call must reject this oversized logical request.
    // E3 owns deterministic complete-call partitioning before transport.
    expect(admit.safeParse(request).success).toBe(false);
  }, 30_000);
});

describe('automation integer column bounds', () => {
  it('rejects a source contract version the Automation integer column cannot hold', () => {
    expect(AutomationEventPositiveSafeIntegerV1Schema.safeParse(AUTOMATION_INT_COLUMN_MAX).success)
      .toBe(true);
    expect(AutomationEventPositiveSafeIntegerV1Schema.safeParse(AUTOMATION_INT_COLUMN_MAX + 1).success)
      .toBe(false);
  });

  it('admits the Event source contract version through the one bounded owner', () => {
    const trigger = {
      kind: 'pluginEvent' as const,
      eventRef: { pluginId: 'com.acme.event-writer', localId: 'pull-request-opened' },
      sourceSelectorId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      sourceContractVersion: AUTOMATION_INT_COLUMN_MAX + 1,
      observation: {
        kind: 'durablePush' as const,
        webhookEndpointId: 'endpoint-1',
        endpointMaterializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.event-writer',
        },
        observationStartsAt: 0,
      },
    };
    expect(AutomationPluginEventTriggerSchema.safeParse(trigger).success).toBe(false);
    expect(AutomationPluginEventTriggerSchema.safeParse({
      ...trigger,
      sourceContractVersion: AUTOMATION_INT_COLUMN_MAX,
    }).success).toBe(true);
  });
});
