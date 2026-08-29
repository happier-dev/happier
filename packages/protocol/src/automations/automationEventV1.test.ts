import { describe, expect, it } from 'vitest';

import {
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
} from '../crypto/accountScopedCipher.js';
import {
  AutomationEventAdmitHostEvidenceV1Schema,
  AutomationEventAdmitInputV1Schema,
  AutomationEventActionHttpRequestSchemasV1,
  AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
  AutomationEventSourceCatalogStatusV1Schema,
  AutomationEventFilterV1Schema,
  AutomationEventSourceStatusReportV1Schema,
  AutomationEventSourceStatusV1Schema,
  AutomationEventStoredDefinitionProjectionV1Schema,
  AutomationEventStoredDefinitionsReadResultV1Schema,
  AutomationEventSourcesListInputV1Schema,
  AutomationEventTriggerDefinitionStoredPayloadV1Schema,
  AutomationEventTriggerObservationTransportV1Schema,
  AutomationStoredContentEnvelopeV1Schema,
  AutomationConversationAdmitInputV1Schema,
  AutomationConversationAdmitResultV1Schema,
  AutomationConversationResultDeliveryV1Schema,
  AutomationConversationTargetVerifyInputV1Schema,
  AutomationIdV1Schema,
  AutomationResultDeliveryActionRefV1Schema,
  AutomationResultDeliveryInputV1JsonSchema,
  AutomationResultDeliveryInputV1Schema,
  AutomationResultDeliveryResultV1JsonSchema,
  AutomationResultDeliveryResultV1Schema,
  AutomationResultDeliverySourceV1JsonSchema,
  AutomationResultDeliverySourceV1Schema,
  AutomationRunResultV1JsonSchema,
  AutomationRunResultV1Schema,
  isAutomationConversationResultDeliveryOwnedByCallerV1,
  MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
  MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
  PluginEventAutomationHistoryGapResetActionInputV1Schema,
  PluginEventAutomationHistoryGapResetActionResultV1Schema,
  PluginEventAutomationDeclarationV1Schema,
  evaluateAutomationEventFilterV1,
  isAutomationEventObservationFreshV1,
  isAutomationEventSourcesListPageProgressingV1,
  validateAutomationEventFilterAgainstPayloadSchemaV1,
} from './automationEventV1.js';
import {
  AutomationEventAdmitItemResultV1Schema,
  AutomationEventSourcesListResultV1Schema,
} from './automationActionSpecsV1.js';
import {
  buildAutomationPluginEventOccurrenceEvidenceV1,
  deriveAutomationOccurrenceKeyV1,
} from './automationOccurrenceV1.js';
import * as AutomationResultDeliveryV1 from './automationResultDeliveryV1.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';

const sourceSelectorId = '9d5af559-2c82-4c22-b6a0-ecabce38a631';
const triggerId = 'trigger-1';
const triggerRevision = 3;
const immutableGenerationId = 'github-immutable-generation-a';
const eventDeclarationRelease = {
  release: { pluginId: 'com.acme.github', version: '1.0.0' },
  archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
} as const;

describe('Automation event V1 contracts', () => {
  it('reexports the exact browser-safe result-delivery values from their canonical leaf', () => {
    expect(isAutomationConversationResultDeliveryOwnedByCallerV1).toBe(
      AutomationResultDeliveryV1.isAutomationConversationResultDeliveryOwnedByCallerV1,
    );
    expect(AutomationConversationAdmitInputV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationConversationAdmitInputV1Schema,
    );
    expect(AutomationConversationAdmitResultV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationConversationAdmitResultV1Schema,
    );
    expect(AutomationConversationAdmitResultV1Schema.parse({
      kind: 'blocked',
      reason: 'resultDeliveryUnsupported',
      checkpointSafe: false,
    })).toEqual({
      kind: 'blocked',
      reason: 'resultDeliveryUnsupported',
      checkpointSafe: false,
    });
    expect(AutomationConversationResultDeliveryV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationConversationResultDeliveryV1Schema,
    );
    expect(AutomationResultDeliveryActionRefV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliveryActionRefV1Schema,
    );
    expect(AutomationResultDeliveryInputV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliveryInputV1Schema,
    );
    expect(AutomationResultDeliveryResultV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliveryResultV1Schema,
    );
    expect(AutomationResultDeliverySourceV1Schema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliverySourceV1Schema,
    );
    expect(AutomationRunResultV1Schema).toBe(AutomationResultDeliveryV1.AutomationRunResultV1Schema);
    expect(AutomationResultDeliveryInputV1JsonSchema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliveryInputV1JsonSchema,
    );
    expect(AutomationResultDeliveryResultV1JsonSchema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliveryResultV1JsonSchema,
    );
    expect(AutomationResultDeliverySourceV1JsonSchema).toBe(
      AutomationResultDeliveryV1.AutomationResultDeliverySourceV1JsonSchema,
    );
    expect(AutomationRunResultV1JsonSchema).toBe(
      AutomationResultDeliveryV1.AutomationRunResultV1JsonSchema,
    );
    expect(MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES).toBe(
      AutomationResultDeliveryV1.MAX_AUTOMATION_SOURCE_RESOLUTION_INPUT_UTF8_BYTES,
    );
    expect(MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS).toBe(
      AutomationResultDeliveryV1.MAX_AUTOMATION_SOURCE_RETRY_AFTER_MS,
    );
  });

  it('reports zero-assignment admission as retryable instead of retiring the definition', () => {
    expect(AutomationEventAdmitItemResultV1Schema.parse({
      kind: 'blocked',
      reason: 'noEnabledAssignment',
      checkpointSafe: false,
    })).toEqual({
      kind: 'blocked',
      reason: 'noEnabledAssignment',
      checkpointSafe: false,
    });
    expect(AutomationConversationAdmitResultV1Schema.parse({
      kind: 'blocked',
      reason: 'noEnabledAssignment',
      checkpointSafe: false,
    })).toEqual({
      kind: 'blocked',
      reason: 'noEnabledAssignment',
      checkpointSafe: false,
    });
  });

  it('uses one exact bounded Automation identity without rewriting its bytes', () => {
    const atLimit = 'a'.repeat(256);

    expect(AutomationIdV1Schema.parse(atLimit)).toBe(atLimit);
    for (const invalid of ['', ' automation-1 ', 'automation-1\n', 'a'.repeat(257)]) {
      expect(AutomationIdV1Schema.safeParse(invalid).success, invalid).toBe(false);
      expect(AutomationConversationTargetVerifyInputV1Schema.safeParse({
        automationId: invalid,
      }).success, invalid).toBe(false);
    }
  });

  it('initializes portable materialization refs without loading Availability release facts', () => {
    expect(AutomationEventTriggerObservationTransportV1Schema.parse({
      kind: 'checkpointedPull',
      watcherMaterializationRef: {
        machineId: 'machine-a',
        materializationId: 'install-epoch-a',
        pluginId: 'com.acme.fixture',
      },
    })).toMatchObject({ kind: 'checkpointedPull' });
  });

  it('keeps the durable endpoint-routing source in the private stored definition payload', () => {
    expect(AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse({
      v: 1,
      sourceInstanceId: 'repository-private-source',
      webhookRoutingSourceInstanceId: 'endpoint-routing-source',
      sourceConfig: { repositoryId: 42 },
      displayLabel: 'Repository 42',
      filter: null,
      maximumObservationAgeMs: null,
    })).toMatchObject({
      sourceInstanceId: 'repository-private-source',
      webhookRoutingSourceInstanceId: 'endpoint-routing-source',
    });
  });

  it('keeps Event eligibility declarative and admits a history-gap reset only for checkpointed pulls', () => {
    expect(PluginEventAutomationDeclarationV1Schema.parse({
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull'],
        sourceConfigSchema: { type: 'object', additionalProperties: false },
        setupActionRef: {
          pluginId: 'com.acme.github',
          localId: 'choose-repository',
        },
        historyGapResetActionRef: {
          pluginId: 'com.acme.github',
          localId: 'baseline-history-gap',
        },
      },
    })).toMatchObject({ eligible: true });

    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['durablePush'],
        sourceConfigSchema: { type: 'object' },
      },
    }).success).toBe(false);

    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['durablePush'],
        sourceConfigSchema: { type: 'object', additionalProperties: false },
        webhookContributionRef: {
          pluginId: 'com.acme.github',
          localId: 'repository-webhook',
        },
        historyGapResetActionRef: {
          pluginId: 'com.acme.github',
          localId: 'baseline-history-gap',
        },
      },
    }).success).toBe(false);
  });

  it('admits a session-socket observation declaration without checkpoint-only roles', () => {
    // A session-bound socket source observes through its own long-lived
    // provider session; it has no ordered pull checkpoint, so it may not
    // declare the checkpointed recovery role.
    expect(PluginEventAutomationDeclarationV1Schema.parse({
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['socket'],
        sourceConfigSchema: { type: 'object', additionalProperties: false },
        setupActionRef: {
          pluginId: 'com.acme.chat',
          localId: 'choose-channel',
        },
      },
    })).toMatchObject({ eligible: true });

    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['socket'],
        sourceConfigSchema: { type: 'object', additionalProperties: false },
        setupActionRef: {
          pluginId: 'com.acme.chat',
          localId: 'choose-channel',
        },
        historyGapResetActionRef: {
          pluginId: 'com.acme.chat',
          localId: 'baseline-history-gap',
        },
      },
    }).success).toBe(false);

    const socketObservation = {
      kind: 'socket' as const,
      watcherMaterializationRef: {
        machineId: 'machine-1',
        pluginId: 'com.acme.chat',
        materializationId: 'chat-generation-1',
      },
    };
    expect(AutomationEventTriggerObservationTransportV1Schema.parse(socketObservation))
      .toEqual(socketObservation);
    expect(AutomationEventTriggerObservationTransportV1Schema.safeParse({
      kind: 'socket',
      watcherMaterializationRef: null,
    }).success).toBe(false);
  });

  it('admits an optional closed renderer chain only as setup Action input presentation', () => {
    const declaration = {
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull'],
        sourceConfigSchema: { type: 'object', additionalProperties: false },
        setupActionRef: {
          pluginId: 'com.acme.github',
          localId: 'choose-repository',
        },
        setupSurface: {
          renderer: 'repository-picker',
          fallbackRenderers: ['repository-picker-hosted'],
        },
      },
    } as const;

    expect(PluginEventAutomationDeclarationV1Schema.parse(declaration).source.setupSurface)
      .toEqual(declaration.source.setupSurface);
    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      ...declaration,
      source: {
        ...declaration.source,
        setupSurface: {
          ...declaration.source.setupSurface,
          targetedContribution: { pointId: 'forged' },
        },
      },
    }).success).toBe(false);
    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      ...declaration,
      source: {
        ...declaration.source,
        setupActionRef: undefined,
      },
    }).success).toBe(false);
  });

  it('requires every Automation-eligible Event to bind one setup Action', () => {
    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull'],
        sourceConfigSchema: { type: 'object', additionalProperties: false },
      },
    }).success).toBe(false);
  });

  it('declares a history-gap recovery Account binding only through one exact source-config ref', () => {
    const qualifiedConnectedAccountRef = {
      type: 'object',
      additionalProperties: false,
      properties: {
        service: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pluginId: { type: 'string' },
            localId: { type: 'string' },
          },
          required: ['pluginId', 'localId'],
        },
        accountId: { type: 'string' },
      },
      required: ['service', 'accountId'],
    } as const satisfies PluginJsonSchemaV2;
    const source = {
      sourceContractVersion: 1,
      supportedObservationTransports: ['checkpointedPull'],
      sourceConfigSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { credentialRef: qualifiedConnectedAccountRef },
        required: ['credentialRef'],
      },
      setupActionRef: {
        pluginId: 'com.acme.github',
        localId: 'choose-repository',
      },
      historyGapResetActionRef: {
        pluginId: 'com.acme.github',
        localId: 'baseline-history-gap',
      },
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: 'github-connected-account',
      }],
    } as const;

    expect(PluginEventAutomationDeclarationV1Schema.parse({
      v: 1,
      eligible: true,
      source,
    })).toMatchObject({ source: { connectedAccountPurposeBindings: source.connectedAccountPurposeBindings } });

    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      v: 1,
      eligible: true,
      source: {
        ...source,
        historyGapResetActionRef: undefined,
      },
    }).success).toBe(false);
    expect(PluginEventAutomationDeclarationV1Schema.safeParse({
      v: 1,
      eligible: true,
      source: {
        ...source,
        connectedAccountPurposeBindings: [{
          path: 'missing',
          purpose: 'github-connected-account',
        }],
      },
    }).success).toBe(false);
  });

  it('keeps history-gap reset inputs and typed no-effect outcomes closed', () => {
    const input = {
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      sourceSelectorId,
    };

    expect(PluginEventAutomationHistoryGapResetActionInputV1Schema.parse(input)).toEqual(input);
    expect(PluginEventAutomationHistoryGapResetActionInputV1Schema.safeParse({
      ...input,
      providerCursor: 'must-not-be-user-input',
    }).success).toBe(false);
    expect(PluginEventAutomationHistoryGapResetActionResultV1Schema.parse({ kind: 'baselined' }))
      .toEqual({ kind: 'baselined' });
    expect(PluginEventAutomationHistoryGapResetActionResultV1Schema.parse({ kind: 'noHistoryGap' }))
      .toEqual({ kind: 'noHistoryGap' });
    expect(PluginEventAutomationHistoryGapResetActionResultV1Schema.parse({ kind: 'stale' }))
      .toEqual({ kind: 'stale' });
    expect(PluginEventAutomationHistoryGapResetActionResultV1Schema.safeParse({
      kind: 'baselined',
      cursor: 'must-not-leak',
    }).success).toBe(false);
  });

  it('uses the one bounded filter grammar and evaluates absent/mismatched fields without coercion', () => {
    const filter = AutomationEventFilterV1Schema.parse({
      v: 1,
      all: [
        { op: 'eq', field: '/repository/id', value: 42 },
        { op: 'in', field: '/action', values: ['opened', 'reopened'] },
      ],
    });

    expect(evaluateAutomationEventFilterV1(filter, {
      repository: { id: 42 },
      action: 'opened',
    })).toBe(true);
    expect(evaluateAutomationEventFilterV1(filter, {
      repository: { id: '42' },
      action: 'opened',
    })).toBe(false);
    expect(evaluateAutomationEventFilterV1(filter, {
      repository: {},
      action: 'opened',
    })).toBe(false);
    expect(AutomationEventFilterV1Schema.safeParse({ v: 1, all: [] }).success)
      .toBe(false);
  });

  it('bounds Event observation freshness by staleness alone, so a source clock that leads this host still admits', () => {
    const occurredAt = 1_700_000_000_000;

    expect(isAutomationEventObservationFreshV1({
      occurredAt,
      observationReceivedAt: occurredAt + 60_000,
      maximumObservationAgeMs: 60_000,
    })).toBe(true);
    expect(isAutomationEventObservationFreshV1({
      occurredAt,
      observationReceivedAt: occurredAt + 60_001,
      maximumObservationAgeMs: 60_000,
    })).toBe(false);
    // A source clock ahead of ours makes the occurrence newer than local time,
    // never staler; skipping it would drop an occurrence that is in fact fresh.
    expect(isAutomationEventObservationFreshV1({
      occurredAt,
      observationReceivedAt: occurredAt - 86_400_000,
      maximumObservationAgeMs: 0,
    })).toBe(true);
    expect(isAutomationEventObservationFreshV1({
      occurredAt,
      observationReceivedAt: occurredAt + 86_400_000,
      maximumObservationAgeMs: null,
    })).toBe(true);
  });

  it('validates bounded Event filter paths and scalar operands against the declared payload schema', () => {
    const payloadSchema: PluginJsonSchemaV2 = {
      oneOf: [{
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { const: 'push' },
          repository: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'integer', minimum: 1 } },
            required: ['id'],
          },
        },
        required: ['kind', 'repository'],
      }, {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { const: 'issueOpened' },
          repository: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'integer', minimum: 1 } },
            required: ['id'],
          },
          issue: {
            type: 'object',
            additionalProperties: false,
            properties: { number: { type: 'integer', minimum: 1 } },
            required: ['number'],
          },
        },
        required: ['kind', 'repository', 'issue'],
      }],
    };

    expect(validateAutomationEventFilterAgainstPayloadSchemaV1({
      payloadSchema,
      filter: AutomationEventFilterV1Schema.parse({
        v: 1,
        all: [
          { op: 'eq', field: '/repository/id', value: 42 },
          { op: 'in', field: '/kind', values: ['push', 'issueOpened'] },
        ],
      }),
    })).toEqual({ kind: 'valid' });

    expect(validateAutomationEventFilterAgainstPayloadSchemaV1({
      payloadSchema,
      filter: AutomationEventFilterV1Schema.parse({
        v: 1,
        all: [{ op: 'eq', field: '/repository/unknown', value: 'missing' }],
      }),
    })).toEqual({
      kind: 'invalid',
      issue: {
        code: 'field_not_declared',
        clauseIndex: 0,
        field: '/repository/unknown',
      },
    });

    expect(validateAutomationEventFilterAgainstPayloadSchemaV1({
      payloadSchema,
      filter: AutomationEventFilterV1Schema.parse({
        v: 1,
        all: [{ op: 'eq', field: '/repository', value: 'not-a-leaf' }],
      }),
    })).toEqual({
      kind: 'invalid',
      issue: {
        code: 'field_not_scalar',
        clauseIndex: 0,
        field: '/repository',
      },
    });

    expect(validateAutomationEventFilterAgainstPayloadSchemaV1({
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
      filter: AutomationEventFilterV1Schema.parse({
        v: 1,
        all: [{ op: 'eq', field: '/labels/0', value: 'bug' }],
      }),
    })).toEqual({
      kind: 'invalid',
      issue: {
        code: 'field_not_declared',
        clauseIndex: 0,
        field: '/labels/0',
      },
    });

    expect(validateAutomationEventFilterAgainstPayloadSchemaV1({
      payloadSchema,
      filter: AutomationEventFilterV1Schema.parse({
        v: 1,
        all: [{ op: 'eq', field: '/repository/id', value: '42' }],
      }),
    })).toEqual({
      kind: 'invalid',
      issue: {
        code: 'value_incompatible',
        clauseIndex: 0,
        field: '/repository/id',
        valueIndex: 0,
      },
    });

    expect(validateAutomationEventFilterAgainstPayloadSchemaV1({
      payloadSchema: null,
      filter: null,
    })).toEqual({
      kind: 'invalid',
      issue: { code: 'payload_schema_missing' },
    });
  });

  it('bounds plugin admission input and keeps source-list cursors host-shaped', () => {
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      occurrenceId: 'event-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: 'x'.repeat(MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES + 1),
      definitions: [{
        automationId: 'automation-1',
        triggerId,
        triggerRevision,
        sourceSelectorId,
      }],
    }).success).toBe(false);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      cursor: 'not a host cursor!',
    }).success).toBe(false);
  });

  it('accepts the signed catalog revision maximum and rejects its next decimal value', () => {
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      knownRevision: '9223372036854775807',
    }).success).toBe(true);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      knownRevision: '9223372036854775808',
    }).success).toBe(false);
  });

  it('keeps durable-push list transport bare while catalog status scopes name their endpoint', () => {
    const endpointId = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'durablePush' },
    }).success).toBe(true);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'durablePush', webhookEndpointId: endpointId },
    }).success).toBe(false);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      kind: 'catalogReconciliation',
      scope: { kind: 'durablePush', webhookEndpointId: endpointId },
      observedRevision: '7',
      adoptedRevision: '7',
      state: 'current',
      scanStartedAt: 1_723_247_200_000,
      nextRetryAt: null,
    }).success).toBe(true);
  });

  it('permits checkpoint retirement classification only as one bounded revision-confirming pull read', () => {
    const candidate = {
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      sourceSelectorId,
      sourceContractVersion: 1,
    } as const;

    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      knownRevision: '7',
      checkpointRetirementCandidates: [candidate],
    }).success).toBe(true);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      checkpointRetirementCandidates: [candidate],
    }).success).toBe(false);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'durablePush' },
      knownRevision: '7',
      checkpointRetirementCandidates: [candidate],
    }).success).toBe(false);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      cursor: 'a'.repeat(43),
      knownRevision: '7',
      checkpointRetirementCandidates: [candidate],
    }).success).toBe(false);
    expect(AutomationEventSourcesListInputV1Schema.safeParse({
      transport: { kind: 'checkpointedPull' },
      knownRevision: '7',
      checkpointRetirementCandidates: [candidate, candidate],
    }).success).toBe(false);
    expect(AutomationEventSourcesListResultV1Schema.safeParse({
      kind: 'unchanged',
      revision: '7',
      checkpointRetirements: [candidate],
    }).success).toBe(true);
    expect(AutomationEventSourcesListResultV1Schema.safeParse({
      kind: 'page',
      revision: '7',
      definitions: [],
      nextCursor: null,
      checkpointRetirements: [],
    }).success).toBe(false);
    expect(isAutomationEventSourcesListPageProgressingV1({
      kind: 'page',
      revision: '7',
      definitions: [],
      nextCursor: 'page-2',
    })).toBe(false);
    expect(isAutomationEventSourcesListPageProgressingV1({
      kind: 'page',
      revision: '7',
      definitions: [],
      nextCursor: null,
    })).toBe(true);
  });

  it('keeps the exact-machine stored-definition hop strict and envelope-only', () => {
    const storedDefinition = {
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      sourceSelectorId,
      sourceContractVersion: 1,
      observationTransport: {
        kind: 'checkpointedPull',
        watcherMaterializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
      },
      storedDefinitionEnvelope: {
        t: 'plain',
        v: {
          v: 1,
          sourceInstanceId: 'repository-1',
          sourceConfig: { repositoryId: 42 },
          displayLabel: 'Repository 42',
          filter: null,
          maximumObservationAgeMs: null,
        },
      },
      payloadSchema: { type: 'object', additionalProperties: false },
    } as const;

    expect(AutomationEventStoredDefinitionProjectionV1Schema.safeParse(storedDefinition).success).toBe(true);
    expect(AutomationEventStoredDefinitionProjectionV1Schema.safeParse({
      ...storedDefinition,
      sourceInstanceId: 'server-readable-source-id',
    }).success).toBe(false);
    expect(AutomationEventStoredDefinitionProjectionV1Schema.safeParse({
      ...storedDefinition,
      accountCurrentness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'forbidden' },
    }).success).toBe(false);

    const page = {
      kind: 'page',
      revision: '7',
      eventDeclarationRelease,
      definitions: [storedDefinition],
      nextCursor: null,
    } as const;
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse(page).success).toBe(true);
    const { eventDeclarationRelease: _eventDeclarationRelease, ...pageWithoutRelease } = page;
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse(pageWithoutRelease).success).toBe(false);
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse({
      ...page,
      scope: 'a'.repeat(43),
    }).success).toBe(true);
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse({
      ...page,
      scope: 'not-an-opaque-scope',
    }).success).toBe(false);
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse({
      ...page,
      definitions: [{
        ...storedDefinition,
        sourceConfig: { repositoryId: 42 },
      }],
    }).success).toBe(false);
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse({
      ...page,
      definitions: [{
        ...storedDefinition,
        eventRef: { pluginId: 'com.acme.other', localId: 'pull-request-opened' },
      }],
    }).success).toBe(false);
    expect(AutomationEventStoredDefinitionsReadResultV1Schema.safeParse({
      ...page,
      caller: {
        pluginId: 'com.acme.github',
        immutableGenerationId,
        materialization: storedDefinition.observationTransport.watcherMaterializationRef,
      },
    }).success).toBe(false);
  });

  it('frames Event Actions with strict host-stamped caller provenance and no target authority', () => {
    const request = AutomationEventActionHttpRequestSchemasV1['automation.event.sources.list'].parse({
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        contributionLocalId: 'repository-events',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
        immutableGenerationId: 'github-immutable-generation-a',
      },
      input: { transport: { kind: 'checkpointedPull' } },
    });

    expect(request).toMatchObject({
      caller: {
        pluginId: 'com.acme.github',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
        immutableGenerationId: 'github-immutable-generation-a',
      },
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
    });
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.sources.list'].safeParse({
      ...request,
      caller: { ...request.caller, accountId: 'caller-controlled-account' },
    }).success).toBe(false);
    const { immutableGenerationId: _generation, ...unstampedCaller } = request.caller;
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.sources.list'].safeParse({
      ...request,
      caller: unstampedCaller,
    }).success).toBe(false);
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.sources.list'].safeParse({
      ...request,
      caller: {
        ...request.caller,
        materialization: {
          ...request.caller.materialization,
          pluginId: 'com.acme.other',
        },
      },
    }).success).toBe(false);
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].safeParse({
      v: 1,
      caller: request.caller,
      input: {
        eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: 'opened' },
        definitions: [{ automationId: 'automation-1', triggerId, triggerRevision, sourceSelectorId }],
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      },
    }).success).toBe(false);
  });

  it('frames the private stored-definition read as an exact host caller, not an Action payload', () => {
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: { pluginId: 'com.acme.github', localId: 'repository-events' },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-routing-source',
      },
      target: {
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
        machineInstallationId: 'installation-1',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const request = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse({
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        immutableGenerationId,
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
      },
      input: { transport: { kind: 'checkpointedPull' } },
      webhookInvocationReference,
    });

    expect(request).toMatchObject({
      caller: {
        pluginId: 'com.acme.github',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
      },
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
      webhookInvocationReference,
    });
    expect(AutomationEventStoredDefinitionsReadHttpRequestV1Schema.safeParse({
      ...request,
      caller: { ...request.caller, accountId: 'caller-controlled-account' },
    }).success).toBe(false);
    expect(AutomationEventStoredDefinitionsReadHttpRequestV1Schema.safeParse({
      ...request,
      input: {
        ...request.input,
        storedDefinitionEnvelope: { t: 'plain', v: { sourceInstanceId: 'forbidden' } },
      },
    }).success).toBe(false);
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.sources.list'].safeParse({
      v: 1,
      caller: request.caller,
      input: request.input,
      webhookInvocationReference,
    }).success).toBe(false);
  });

  it('uses a stripped strict E2EE Event-admission body while retaining the semantic plain body', () => {
    const input = {
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [{ automationId: 'automation-1', triggerId, triggerRevision, sourceSelectorId }],
    } as const;
    const caller = {
      pluginId: 'com.acme.github',
      immutableGenerationId,
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'com.acme.github',
      },
    } as const;
    const plainHostEvidence = {
      v: 1,
      t: 'plain',
      accountCurrentness: {
        mode: 'plain',
        version: 7,
        contentKeyFingerprint: null,
      },
    } as const;
    const encryptedTriggerEvidenceCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
      payload: { v: 1 },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const encryptedHostEvidence = {
      v: 1,
      t: 'encrypted',
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: 'aemk1_content_key',
      },
      adoptedRevision: '9',
      eventRef: input.eventRef,
      eventDeclarationRelease,
      definitions: [{
        automationId: 'automation-1',
        triggerId,
        triggerRevision,
        sourceSelectorId,
        sourceContractVersion: 1,
        observationTransport: 'checkpointedPull',
        occurrenceKey: deriveAutomationOccurrenceKeyV1({
          triggerId,
          evidence: buildAutomationPluginEventOccurrenceEvidenceV1({
            eventRef: input.eventRef,
            sourceSelectorId,
            occurrenceId: input.occurrenceId,
            occurredAt: input.occurredAt,
            payload: input.payload,
          }),
        }),
        occurredAt: input.occurredAt,
        triggerEvidenceEnvelope: { t: 'encrypted', c: encryptedTriggerEvidenceCiphertext },
        occurrenceEvidenceEqualityTag: 'A'.repeat(43),
        outcome: { kind: 'matched' },
      }],
    } as const;

    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...input,
      hostEvidence: plainHostEvidence,
    }).success).toBe(false);
    expect(AutomationEventAdmitInputV1Schema.safeParse({
      ...input,
      webhookInvocationReference: {
        v: 1,
        deliveryId: 'delivery-1',
        endpoint: {
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
          revision: 3,
          webhookContribution: {
            pluginId: 'com.acme.github',
            localId: 'repository-events',
          },
          handlerActionLocalId: 'receive-repository-events',
          sourceInstanceId: 'repository-1',
        },
        target: {
          materialization: caller.materialization,
          machineInstallationId: 'installation-1',
        },
        lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
      },
    }).success).toBe(false);

    const admit = AutomationEventActionHttpRequestSchemasV1['automation.event.admit'];
    expect(admit.safeParse({ v: 1, caller, input, hostEvidence: plainHostEvidence }).success).toBe(true);
    expect(admit.safeParse({ v: 1, caller, hostEvidence: encryptedHostEvidence }).success).toBe(true);
    const { eventDeclarationRelease: _encryptedRelease, ...encryptedHostEvidenceWithoutRelease } = encryptedHostEvidence;
    expect(admit.safeParse({
      v: 1,
      caller,
      hostEvidence: encryptedHostEvidenceWithoutRelease,
    }).success).toBe(false);
    expect(admit.safeParse({ v: 1, caller, input, hostEvidence: encryptedHostEvidence }).success).toBe(false);
    expect(admit.safeParse({
      v: 1,
      caller,
      hostEvidence: {
        ...encryptedHostEvidence,
        payloadSchema: { type: 'object' },
      },
    }).success).toBe(false);
    expect(admit.safeParse({
      v: 1,
      caller,
      input,
      hostEvidence: { ...plainHostEvidence, definitions: [] },
    }).success).toBe(false);
    expect(admit.safeParse({
      v: 1,
      caller,
      input,
      hostEvidence: {
        ...encryptedHostEvidence,
        accountCurrentness: {
          mode: 'plain',
          version: 8,
          contentKeyFingerprint: null,
        },
      },
    }).success).toBe(false);
    expect(admit.safeParse({
      v: 1,
      caller,
      input,
      hostEvidence: {
        ...encryptedHostEvidence,
        definitions: [{
          ...encryptedHostEvidence.definitions[0],
          triggerEvidenceEnvelope: { t: 'plain', v: { leaked: true } },
        }],
      },
    }).success).toBe(false);
  });

  it('keeps encrypted private Event evidence canonically encoded and within the stored-envelope bound', () => {
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(7) },
      payload: { v: 1 },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    expect(readAccountScopedCiphertextKindByte(ciphertext)).toBe(19);
    const eventRef = { pluginId: 'com.acme.github', localId: 'pull-request-opened' } as const;
    const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef,
      sourceSelectorId,
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      payload: { action: 'opened' },
    });
    const hostEvidence = {
      v: 1,
      t: 'encrypted',
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: 'aemk1_content_key',
      },
      adoptedRevision: '9',
      eventRef,
      eventDeclarationRelease,
      definitions: [{
        automationId: 'automation-1',
        triggerId,
        triggerRevision,
        sourceSelectorId,
        sourceContractVersion: 1,
        observationTransport: 'checkpointedPull',
        occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }),
        occurredAt: 1,
        triggerEvidenceEnvelope: { t: 'encrypted', c: ciphertext },
        occurrenceEvidenceEqualityTag: 'A'.repeat(43),
        outcome: { kind: 'skipped', reason: 'filtered' },
      }],
    } as const;
    const oversizedEnvelope = { t: 'encrypted', c: 'A'.repeat(600_056) } as const;

    expect(AutomationEventAdmitHostEvidenceV1Schema.safeParse(hostEvidence).success).toBe(true);
    expect(AutomationStoredContentEnvelopeV1Schema.safeParse(oversizedEnvelope).success).toBe(false);
    expect(AutomationEventAdmitHostEvidenceV1Schema.safeParse({
      ...hostEvidence,
      definitions: [{
        ...hostEvidence.definitions[0],
        triggerEvidenceEnvelope: oversizedEnvelope,
      }],
    }).success).toBe(false);
    expect(AutomationEventAdmitHostEvidenceV1Schema.safeParse({
      ...hostEvidence,
      definitions: [{
        ...hostEvidence.definitions[0],
        triggerEvidenceEnvelope: { t: 'encrypted', c: `${ciphertext}#` },
      }],
    }).success).toBe(false);
  });

  it('rejects an opaque Webhook invocation reference from the Event Action caller frame', () => {
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: {
          pluginId: 'com.acme.github',
          localId: 'repository-events',
        },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-1',
      },
      target: {
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
        machineInstallationId: 'installation-1',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const caller = {
      pluginId: 'com.acme.github',
      contributionLocalId: 'repository-events',
      immutableGenerationId,
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'com.acme.github',
      },
      webhookInvocationReference,
    };

    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.source.status.report'].safeParse({
      v: 1,
      caller,
      input: {
        kind: 'catalogReconciliation',
        scope: {
          kind: 'durablePush',
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
    }).success).toBe(false);
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.sources.list'].safeParse({
      v: 1,
      caller,
      input: { transport: { kind: 'checkpointedPull' } },
    }).success).toBe(false);
    expect(AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].safeParse({
      v: 1,
      caller,
      input: {
        eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: 'opened' },
        definitions: [{ automationId: 'automation-1', triggerId, triggerRevision, sourceSelectorId }],
      },
      hostEvidence: {
        v: 1,
        t: 'plain',
        accountCurrentness: {
          mode: 'plain',
          version: 7,
          contentKeyFingerprint: null,
        },
      },
    }).success).toBe(false);
  });

  it('accepts only bounded source or catalog reconciliation reports', () => {
    const source = {
      kind: 'source',
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      sourceSelectorId,
      state: 'observing',
      code: 'none',
      lastObservedAt: 10,
      lastDispositionAt: 11,
      nextRetryAt: null,
      observedDelta: 1,
      admittedDelta: 1,
      skippedDelta: 0,
    } as const;

    expect(AutomationEventSourceStatusReportV1Schema.parse(source)).toEqual(source);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      ...source,
      observedDelta: 101,
    }).success).toBe(false);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      ...source,
      state: 'attention',
      code: 'none',
    }).success).toBe(false);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      kind: 'catalogReconciliation',
      scope: { kind: 'checkpointedPull' },
      observedRevision: '4',
      adoptedRevision: null,
      state: 'current',
      scanStartedAt: 1,
      nextRetryAt: null,
    }).success).toBe(false);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      kind: 'catalogReconciliation',
      scope: { kind: 'checkpointedPull' },
      observedRevision: '4',
      adoptedRevision: '4',
      state: 'reconciling',
      scanStartedAt: 1,
      nextRetryAt: null,
    }).success).toBe(false);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      kind: 'catalogReconciliation',
      scope: { kind: 'checkpointedPull' },
      observedRevision: '4',
      adoptedRevision: '3',
      state: 'reconciling',
      scanStartedAt: 1,
      nextRetryAt: null,
    }).success).toBe(true);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      kind: 'catalogReconciliation',
      scope: { kind: 'checkpointedPull' },
      observedRevision: '4',
      adoptedRevision: '4',
      state: 'current',
      scanStartedAt: 1,
      nextRetryAt: null,
      reporterMaterializationRef: { machineId: 'must-be-host-derived' },
    }).success).toBe(false);
  });

  it('projects the host-stamped immutable reporter generation without accepting it from a reporter', () => {
    const sourceReport = {
      kind: 'source',
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
      sourceSelectorId,
      state: 'attention',
      code: 'historyGap',
      lastObservedAt: 10,
      lastDispositionAt: 10,
      nextRetryAt: null,
      observedDelta: 0,
      admittedDelta: 0,
      skippedDelta: 0,
    } as const;
    const projectedStatus = {
      automationId: sourceReport.automationId,
      triggerId: sourceReport.triggerId,
      triggerRevision: sourceReport.triggerRevision,
      eventRef: sourceReport.eventRef,
      sourceSelectorId,
      reporterMaterializationRef: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'com.acme.github',
      },
      reporterImmutableGenerationId: 'gen-github-immutable-a',
      state: sourceReport.state,
      code: sourceReport.code,
      lastObservedAt: sourceReport.lastObservedAt,
      lastDispositionAt: sourceReport.lastDispositionAt,
      nextRetryAt: sourceReport.nextRetryAt,
      observedCount: 0,
      admittedCount: 0,
      skippedCount: 0,
      revision: 1,
    } as const;

    expect(AutomationEventSourceStatusV1Schema.parse(projectedStatus)).toEqual(projectedStatus);
    expect(AutomationEventSourceStatusReportV1Schema.safeParse({
      ...sourceReport,
      reporterImmutableGenerationId: 'gen-github-immutable-a',
    }).success).toBe(false);
  });

  it('delegates durable-push catalog scope identity to the canonical webhook endpoint schema', () => {
    expect(AutomationEventSourceCatalogStatusV1Schema.safeParse({
      accountId: 'account-1',
      eventPluginId: 'com.acme.github',
      reporterMaterializationRef: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'com.acme.github',
      },
      reporterImmutableGenerationId: 'github-immutable-generation-a',
      scopeKey: 'durablePush:wh_ep_AAAAAAAAAAAAAAAAAAAAAB',
      observedRevision: '1',
      adoptedRevision: '1',
      state: 'current',
      scanStartedAt: 1,
      nextRetryAt: null,
      reportedAt: 2,
      revision: 1,
    }).success).toBe(false);
  });
});
