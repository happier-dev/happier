import { describe, expect, it } from 'vitest';

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
  MAX_AUTOMATION_EVENT_FILTER_CLAUSES,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_ACTION,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
  MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
  MAX_AUTOMATION_EVENT_FILTER_IN_VALUES,
  MAX_AUTOMATION_EVENT_FILTER_VALUE_CODE_POINTS,
  MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
  MAX_AUTOMATION_REPLY_CONTEXT_UTF8_BYTES,
  MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES,
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
    templateVersion: 1,
    eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
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
    eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
    occurrenceId,
    occurredAt: 1,
    observationReceivedAt: 2,
    payload,
    definitions: [{ automationId: 'automation-1', templateVersion: 1, sourceSelectorId }],
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
    const maxPortableOriginOccurredAt = 253_402_300_799_999;
    const conversation = {
      automationId: 'automation-1',
      bindingId: 'binding-1',
      templateVersion: 1,
      occurrenceId: 'occurrence-1',
      occurredAt: maxPortableOriginOccurredAt,
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
      occurredAt: maxPortableOriginOccurredAt,
    }).success).toBe(true);
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      occurredAt: maxPortableOriginOccurredAt + 1,
    }).success).toBe(false);
    expect(AutomationConversationAdmitInputV1Schema.safeParse(conversation).success).toBe(true);
    expect(AutomationConversationAdmitInputV1Schema.safeParse({
      ...conversation,
      occurredAt: maxPortableOriginOccurredAt + 1,
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

    const senderAtMax = 'x'.repeat(MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES - 2);
    const textAtMax = 'x'.repeat(MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES);
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

    const admitDefinitionsAtActionMax = Array.from(
      { length: MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_ACTION },
      (_, index) => ({ automationId: `automation-${index}`, templateVersion: 1, sourceSelectorId }),
    );
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: admitDefinitionsAtActionMax,
    }).success).toBe(true);
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: [...admitDefinitionsAtActionMax, admitDefinitionsAtActionMax[0]],
    }).success).toBe(false);

    const admitDefinitionsAtCallMax = admitDefinitionsAtActionMax.slice(
      0,
      MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
    );
    expect(AutomationEventAdmitHttpInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: admitDefinitionsAtCallMax,
    }).success).toBe(true);
    expect(AutomationEventAdmitHttpInputV1Schema.safeParse({
      ...admitInput({}),
      definitions: [...admitDefinitionsAtCallMax, admitDefinitionsAtActionMax[15]],
    }).success).toBe(false);

    const actionResultsAtMax = Array.from(
      { length: MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_ACTION },
      () => ({ kind: 'skipped' as const, reason: 'filtered' as const, checkpointSafe: true as const }),
    );
    expect(AutomationEventAdmitResultV1Schema.safeParse({ results: actionResultsAtMax }).success).toBe(true);
    expect(AutomationEventAdmitResultV1Schema.safeParse({
      results: [...actionResultsAtMax, actionResultsAtMax[0]],
    }).success).toBe(false);

    const callResultsAtMax = actionResultsAtMax.slice(
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
      results: [...callResultsAtMax, actionResultsAtMax[15]],
      continuation: readyContinuation,
    }).success).toBe(false);
  });

  it('accepts exact result/reply/stored-envelope/retry maxima and rejects max-plus-one', () => {
    const resultTextAtMax = 'x'.repeat(MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES);
    expect(AutomationRunResultV1Schema.safeParse({ v: 1, kind: 'text', text: resultTextAtMax }).success).toBe(true);
    expect(AutomationRunResultV1Schema.safeParse({ v: 1, kind: 'text', text: `${resultTextAtMax}x` }).success).toBe(false);
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
      templateVersion: 3,
      resultDelivery: 'finalResult',
    } as const;

    expect(AutomationResultDeliveryInputV1Schema.safeParse(delivery).success).toBe(false);
    expect(AutomationResultDeliveryInputV1Schema.safeParse({ ...delivery, source }).success).toBe(true);
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

    it('measures an encrypted Event admit body exactly at its canonical transport ceiling and one byte over', () => {
    const eventRef = { pluginId: 'com.acme.github', localId: 'repository-event' } as const;
    const caller = {
      pluginId: eventRef.pluginId,
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
        payload: { v: 1 },
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
    const recipeAtLimit = 'x'.repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES);
    const definition = (recipe: string) => ({
      automationId: 'automation-1',
      templateVersion: 1,
      sourceSelectorId,
      sourceContractVersion: 1,
      observationTransport: 'checkpointedPull' as const,
      occurrenceKey,
      occurredAt: 1,
      triggerEvidenceEnvelope,
      occurrenceEvidenceEqualityTag: 'A'.repeat(43),
      outcome: { kind: 'matched' as const, executionRecipe: recipe },
    });
    const request = (definitions: readonly ReturnType<typeof definition>[], adoptedRevision: string) => ({
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
        adoptedRevision,
        eventRef,
        eventDeclarationRelease: {
          release: { pluginId: eventRef.pluginId, version: '1.0.0' },
          archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        },
        definitions,
      },
    });
    const emptyRequest = request([], '9');
    const oneDefinitionBytes = readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(request([definition(recipeAtLimit)], '9'))
      - readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(emptyRequest);
    const fullyFittingDefinitionCount = Math.floor(
      (MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES
        - readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(emptyRequest) + 1)
      / (oneDefinitionBytes + 1),
    );
    expect(fullyFittingDefinitionCount).toBeGreaterThan(1);
    const oversizeDefinitions = Array.from(
      { length: fullyFittingDefinitionCount + 1 },
      () => definition(recipeAtLimit),
    );
    let bytesToRemove = readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(request(oversizeDefinitions, '9'))
      - MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES;
    expect(bytesToRemove).toBeGreaterThan(0);
    const atLimitDefinitions = oversizeDefinitions.map((candidate) => {
      const availableReduction = MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES - 1;
      const reduction = Math.min(bytesToRemove, availableReduction);
      bytesToRemove -= reduction;
      return reduction === 0
        ? candidate
        : { ...candidate, outcome: { kind: 'matched' as const, executionRecipe: 'x'.repeat(recipeAtLimit.length - reduction) } };
    });
    expect(bytesToRemove).toBe(0);
    const atLimit = request(atLimitDefinitions, '9');
    const oneByteOver = request(atLimitDefinitions, '99');
    expect(readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(atLimit))
      .toBe(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES);
    expect(readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(oneByteOver))
      .toBe(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES + 1);
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength)
      .toBe(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(oneByteOver)).byteLength)
      .toBe(MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES + 1);
    // This is a transport-size measurement only. E3 must partition the
    // complete logical aggregate before the private E2 schema boundary.
  });

  it('retains the approved 500-definition encrypted Event batch as a logical request when every definition is individually within its stored-content bound', () => {
    const eventRef = { pluginId: 'com.acme.github', localId: 'repository-event' } as const;
    const caller = {
      pluginId: eventRef.pluginId,
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
        payload: { v: 1 },
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
    // ceiling. The approved Action cardinality is still 500 definitions.
    const executionRecipe = 'x'.repeat(34 * 1024);
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
          templateVersion: 1,
          sourceSelectorId,
          sourceContractVersion: 1,
          observationTransport: 'checkpointedPull' as const,
          occurrenceKey,
          occurredAt: 1,
          triggerEvidenceEnvelope,
          occurrenceEvidenceEqualityTag: 'A'.repeat(43),
          outcome: { kind: 'matched' as const, executionRecipe },
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
  });
});
