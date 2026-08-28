import { describe, expect, it } from 'vitest';

import * as Api from './automationApiV3.js';
import { AutomationRunReplyHandoffStateV1Schema } from './automationEventV1.js';

const timestamp = 1_786_257_600_000;
const occurrenceKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const templateCiphertext = '{"kind":"happier_automation_template_plain_v1"}';

const recipe = {
  v: 1 as const,
  templateVersion: 3,
  template: { t: 'plain' as const, v: { v: 1 as const, prompt: 'Run the current task.' } },
  triggerEvidence: null,
  target: {
    kind: 'executionRun' as const,
    request: {
      intent: 'task' as const,
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
      permissionMode: 'read_only' as const,
      retentionPolicy: 'ephemeral' as const,
      runClass: 'bounded' as const,
      ioMode: 'request_response' as const,
    },
  },
};

const scheduleInput = {
  kind: 'schedule' as const,
  enabled: true,
  schedule: {
    kind: 'interval' as const,
    scheduleExpr: null,
    everyMs: 60_000,
    timezone: null,
  },
};

const eventInput = {
  kind: 'pluginEvent' as const,
  enabled: true,
  eventRef: { pluginId: 'happier.scm.github', localId: 'issue-opened-v1' },
  sourceInstanceId: 'github:repository:1234',
  sourceContractVersion: 1,
  sourceConfig: { credentialRef: 'github:account:1', repository: 'happier-dev/happier' },
  displayLabel: 'happier-dev/happier',
  observationTransport: {
    kind: 'checkpointedPull' as const,
    watcherMaterializationRef: {
      machineId: 'machine-1',
      materializationId: 'materialization-1',
      pluginId: 'happier.scm.github',
    },
  },
  filter: null,
  maximumObservationAgeMs: 60_000,
};

const lifecycleInput = {
  kind: 'sessionLifecycle' as const,
  enabled: false,
  event: 'parentTurnCompleted' as const,
  scope: {
    kind: 'exactTurn' as const,
    sourceSessionId: 'session-source',
    sourceTurnId: 'turn-42',
  },
  consumption: 'once' as const,
};

const schedule = {
  id: 'trigger-schedule',
  revision: 4,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...scheduleInput,
  nextRunAt: timestamp,
};

const event = {
  id: 'trigger-event',
  revision: 7,
  enabled: true,
  kind: 'pluginEvent' as const,
  eventRef: { pluginId: 'com.example.github', localId: 'issue/opened' },
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
  sourceContractVersion: 2,
  observation: {
    kind: 'durablePush' as const,
    webhookEndpointId: 'endpoint-1',
    endpointMaterializationRef: {
      machineId: 'observation-machine-1',
      materializationId: 'observation-materialization-1',
      pluginId: 'com.example.github',
    },
    observationStartsAt: timestamp,
  },
  sourceStatus: null,
  sourceCatalogStatus: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const lifecycle = {
  id: 'trigger-turn',
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...lifecycleInput,
  status: { state: 'waiting' as const, runId: null },
};

const listDefinition = {
  id: 'automation-current',
  name: 'Current task',
  description: null,
  enabled: true,
  targetType: 'executionRun' as const,
  existingSessionId: null,
  templateVersion: 3,
  lastRunAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
  triggers: [schedule, event, lifecycle],
  retiredTriggers: [{
    id: 'trigger-retired',
    kind: 'sessionLifecycle' as const,
    revision: 7,
    retiredAt: timestamp,
  }],
};

const eventCause = {
  kind: 'trigger' as const,
  triggerId: event.id,
  triggerRevision: event.revision,
  triggerKind: 'pluginEvent' as const,
  occurrenceKey,
  occurredAt: timestamp,
  evidence: { eventRef: event.eventRef, sourceSelectorId: event.sourceSelectorId },
};

const run = {
  id: 'run-event',
  automationId: listDefinition.id,
  revision: 1,
  triggerId: event.id,
  triggerRetired: false,
  state: 'queued' as const,
  cause: eventCause,
  dueAt: timestamp,
  claimedAt: null,
  startedAt: null,
  finishedAt: null,
  claimedByMachineId: null,
  leaseExpiresAt: null,
  attempt: 0,
  errorCode: 'source_waiting',
  producedSessionId: null,
  executionDispatchState: null,
  executionAttempt: 0,
  replyHandoffState: 'none' as const,
  replyHandoffAttempt: 0,
  replyHandoffDueAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe('Automation versioned API schemas', () => {
  it('keeps one reply-handoff owner and no singular definition aliases', () => {
    expect(Api.AutomationReplyHandoffStateV3Schema).toBe(AutomationRunReplyHandoffStateV1Schema);
    expect(Api).not.toHaveProperty('AutomationV3DefinitionSchema');
    expect(Api).not.toHaveProperty('AutomationManualDefinitionCreateRequestSchema');
    expect(Api).not.toHaveProperty('AutomationScheduleDefinitionCreateRequestSchema');
    expect(Api).not.toHaveProperty('AutomationPluginEventDefinitionCreateRequestSchema');
  });

  it('accepts zero or many independently enabled automatic triggers', () => {
    const base = {
      automationId: 'automation-create-1',
      name: 'On demand task',
      enabled: true,
      executionRecipe: recipe,
      assignments: [{ machineId: 'machine-1' }],
    };
    expect(Api.AutomationDefinitionCreateRequestSchema.parse({ ...base, triggers: [] }).triggers)
      .toEqual([]);
    const { automationId: _automationId, ...unboundBase } = base;
    expect(Api.AutomationDefinitionCreateRequestSchema.safeParse({
      ...unboundBase,
      triggers: [],
    }).success).toBe(false);
    expect(Api.AutomationDefinitionCreateRequestSchema.parse({
      ...base,
      triggers: [
        { triggerId: 'trigger-create-schedule', trigger: scheduleInput },
        { triggerId: 'trigger-create-event', trigger: eventInput },
        { triggerId: 'trigger-create-lifecycle', trigger: lifecycleInput },
      ],
    }).triggers).toHaveLength(3);
    expect(Api.AutomationDefinitionCreateRequestSchema.safeParse({
      ...base,
      trigger: { kind: 'manual' },
      triggers: [],
    }).success).toBe(false);
    expect(Api.AutomationDefinitionCreateRequestSchema.safeParse({
      ...base,
      triggers: [
        { triggerId: 'duplicate-trigger', trigger: scheduleInput },
        { triggerId: 'duplicate-trigger', trigger: lifecycleInput },
      ],
    }).success).toBe(false);
  });

  it('uses strict trigger CRUD with stable identity and revision', () => {
    expect(Api.AutomationTriggerCreateRequestSchema.parse({
      triggerId: 'trigger-create-event',
      trigger: eventInput,
    })).toEqual({ triggerId: 'trigger-create-event', trigger: eventInput });
    expect(Api.AutomationTriggerCreateRequestSchema.safeParse({ trigger: eventInput }).success)
      .toBe(false);
    expect(Api.AutomationTriggerPatchRequestSchema.parse({
      triggerId: event.id,
      expectedRevision: event.revision,
      enabled: false,
    })).toEqual({ triggerId: event.id, expectedRevision: event.revision, enabled: false });
    const { enabled: _eventEnabled, ...eventDefinition } = eventInput;
    expect(Api.AutomationTriggerPatchRequestSchema.parse({
      triggerId: event.id,
      expectedRevision: event.revision,
      trigger: eventDefinition,
    }).trigger).toEqual(eventDefinition);
    expect(Api.AutomationTriggerPatchRequestSchema.safeParse({
      triggerId: event.id,
      expectedRevision: event.revision,
      enabled: false,
      trigger: eventInput,
    }).success).toBe(false);
    expect(Api.AutomationTriggerDeleteRequestSchema.parse({
      triggerId: event.id,
      expectedRevision: event.revision,
    })).toEqual({ triggerId: event.id, expectedRevision: event.revision });
    expect(Api.AutomationTriggerPatchRequestSchema.safeParse({
      triggerId: event.id,
      expectedRevision: event.revision,
    }).success).toBe(false);
    for (const field of ['sourceSelectorId', 'triggerDefinitionEnvelope', 'providerPayload']) {
      expect(Api.AutomationTriggerCreateRequestSchema.safeParse({
        triggerId: 'trigger-create-event',
        trigger: { ...eventInput, [field]: 'caller-controlled' },
      }).success).toBe(false);
    }
  });

  it('accepts one exact full-editor reconciliation census without forcing a recipe write', () => {
    const request = {
      expectedTemplateVersion: 3,
      name: 'Renamed without resealing',
      description: null,
      enabled: true,
      assignments: [{ machineId: 'machine-1', enabled: true, priority: 0 }],
      triggers: [
        { kind: 'existing' as const, triggerId: schedule.id, expectedRevision: schedule.revision },
        { kind: 'new' as const, triggerId: 'trigger-new', trigger: lifecycleInput },
      ],
      removedTriggers: [{ triggerId: event.id, expectedRevision: event.revision }],
    };
    expect(Api.AutomationDefinitionReconcileRequestSchema.parse(request)).toEqual(request);
    expect(Api.AutomationDefinitionReconcileRequestSchema.safeParse({
      ...request,
      triggers: [
        ...request.triggers,
        { kind: 'existing', triggerId: event.id, expectedRevision: event.revision },
      ],
    }).success).toBe(false);
    expect(Api.AutomationDefinitionReconcileRequestSchema.parse({
      ...request,
      executionRecipe: { ...recipe, templateVersion: 4 },
    }).executionRecipe?.templateVersion).toBe(4);
  });

  it('accepts one strict ciphertext-blind Event authoring arm bound by client-stable ids', () => {
    const encrypted = {
      kind: 'pluginEvent' as const,
      enabled: true,
      eventRef: eventInput.eventRef,
      sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      sourceContractVersion: eventInput.sourceContractVersion,
      observationTransport: eventInput.observationTransport,
      triggerDefinitionEnvelope: { t: 'encrypted' as const, c: 'opaque-trigger-definition' },
    };
    const request = {
      automationId: 'automation-encrypted-1',
      name: 'Encrypted Event task',
      enabled: true,
      executionRecipe: {
        ...recipe,
        template: { t: 'encrypted' as const, c: 'opaque-template' },
      },
      triggers: [{ triggerId: 'trigger-encrypted-1', trigger: encrypted }],
    };
    expect(Api.AutomationDefinitionCreateRequestSchema.parse(request)).toEqual({
      ...request,
      executionRecipe: {
        ...request.executionRecipe,
        target: {
          ...request.executionRecipe.target,
          request: {
            ...request.executionRecipe.target.request,
            backendTarget: {
              kind: 'backend',
              backendId: 'codex',
              sourceKind: 'built_in',
            },
          },
        },
      },
    });
    expect(Api.AutomationTriggerCreateRequestSchema.parse(request.triggers[0])).toEqual(request.triggers[0]);
    expect(Api.AutomationTriggerCreateRequestSchema.safeParse({
      ...request.triggers[0],
      trigger: { ...encrypted, sourceConfig: { secret: true } },
    }).success).toBe(false);
    expect(Api.AutomationTriggerCreateRequestSchema.safeParse({
      ...request.triggers[0],
      trigger: {
        ...encrypted,
        triggerDefinitionEnvelope: { t: 'plain', v: { private: true } },
      },
    }).success).toBe(false);
    expect(Api.AutomationTriggerPatchRequestSchema.parse({
      triggerId: 'trigger-encrypted-1',
      expectedRevision: 0,
      trigger: (({ enabled: _enabled, ...definition }) => definition)(encrypted),
    }).trigger).not.toHaveProperty('enabled');

    const enableOnlyReseal = {
      triggerId: 'trigger-encrypted-1',
      expectedRevision: 0,
      enabled: false,
      triggerDefinitionEnvelope: { t: 'encrypted' as const, c: 'opaque-next-revision-definition' },
    };
    expect(Api.AutomationTriggerPatchRequestSchema.parse(enableOnlyReseal))
      .toEqual(enableOnlyReseal);
    expect(Api.AutomationTriggerPatchRequestSchema.safeParse({
      ...enableOnlyReseal,
      enabled: undefined,
    }).success).toBe(false);
    expect(Api.AutomationTriggerPatchRequestSchema.safeParse({
      ...enableOnlyReseal,
      trigger: (({ enabled: _enabled, ...definition }) => definition)(encrypted),
    }).success).toBe(false);
    expect(Api.AutomationTriggerPatchRequestSchema.safeParse({
      ...enableOnlyReseal,
      triggerDefinitionEnvelope: { t: 'plain', v: { private: true } },
    }).success).toBe(false);
  });

  it('accepts durable push without server-owned observation facts', () => {
    const push = {
      ...eventInput,
      observationTransport: {
        kind: 'durablePush' as const,
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        endpointMaterializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.scm.github',
        },
        webhookRoutingSourceInstanceId: 'github:installation:2200',
        setup: { kind: 'githubAccountEndpointV1' as const, credential: 'serverGenerated' as const },
      },
    };
    expect(Api.AutomationTriggerCreateRequestSchema.parse({
      triggerId: 'trigger-create-push',
      trigger: push,
    }).trigger)
      .toEqual(push);
    expect(Api.AutomationTriggerCreateRequestSchema.safeParse({
      triggerId: 'trigger-create-push',
      trigger: {
        ...push,
        observationTransport: { ...push.observationTransport, observationStartsAt: timestamp },
      },
    }).success).toBe(false);
    expect(Api.AutomationTriggerCreateRequestSchema.safeParse({
      triggerId: 'trigger-create-push',
      trigger: {
        ...push,
        observationTransport: { ...push.observationTransport, webhookEndpointId: 'endpoint-1' },
      },
    }).success).toBe(false);
  });

  it('keeps exact released V2 vectors isolated from triggers and causes', () => {
    const definition = {
      id: 'automation-1', name: 'Daily summary', description: null, enabled: true,
      schedule: scheduleInput.schedule, targetType: 'new_session' as const, templateCiphertext,
      templateVersion: 1, nextRunAt: timestamp, lastRunAt: null, createdAt: timestamp,
      updatedAt: timestamp,
      assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
    };
    const v2Run = {
      id: 'run-1', automationId: 'automation-1', state: 'queued' as const,
      scheduledAt: timestamp, dueAt: timestamp, claimedAt: null, startedAt: null,
      finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null, attempt: 0,
      summaryCiphertext: null, errorCode: null, errorMessage: null, producedSessionId: null,
      createdAt: timestamp, updatedAt: timestamp,
    };
    expect(Api.AutomationApiV2Schema.parse(definition)).toEqual(definition);
    expect(Api.AutomationRunApiV2Schema.parse(v2Run)).toEqual(v2Run);
    expect(Api.AutomationApiV2Schema.safeParse({ ...definition, triggers: [] }).success).toBe(false);
    expect(Api.AutomationRunApiV2Schema.safeParse({ ...v2Run, cause: { kind: 'manual' } }).success)
      .toBe(false);
  });

  it('projects plural trigger identity while keeping private definitions detail-only', () => {
    const detail = {
      ...listDefinition,
      executionRecipe: recipe,
      triggers: [
        { ...schedule, triggerDefinitionEnvelope: null },
        { ...event, triggerDefinitionEnvelope: '{"t":"plain","v":{"source":"private"}}' },
        { ...lifecycle, triggerDefinitionEnvelope: null },
      ],
    };
    expect(Api.AutomationDefinitionListItemSchema.parse(listDefinition)).toEqual(listDefinition);
    expect(Api.AutomationDefinitionDetailSchema.parse(detail)).toMatchObject({
      id: detail.id,
      triggers: detail.triggers,
      executionRecipe: { templateVersion: 3 },
    });
    expect(Api.AutomationDefinitionListItemSchema.safeParse(detail).success).toBe(false);
    expect(Api.AutomationDefinitionListItemSchema.safeParse({
      ...listDefinition,
      trigger: schedule,
    }).success).toBe(false);
    expect(Api.AutomationDefinitionDetailSchema.safeParse({
      ...detail,
      executionRecipe: { ...recipe, assignmentMachineIds: ['machine-1'] },
    }).success).toBe(false);
  });

  it('owns stable exact-turn registration refusal codes', () => {
    for (const code of [
      'sourceSessionUnavailable',
      'sourceTurnNotCurrent',
      'sourceTurnUnavailable',
      'sourceTurnNotInProgress',
      'executionTargetInequalityUnproven',
      'sourceMatchesExecutionTarget',
    ]) {
      expect(Api.AutomationSessionLifecycleRegistrationErrorCodeSchema.parse(code)).toBe(code);
    }
    expect(Api.AutomationSessionLifecycleRegistrationErrorCodeSchema.safeParse(
      'watcherDisconnected',
    ).success).toBe(false);
  });

  it('requires nullable Event statuses and bounds current trigger-scoped status', () => {
    const status = {
      automationId: listDefinition.id,
      triggerId: event.id,
      triggerRevision: event.revision,
      eventRef: event.eventRef,
      sourceSelectorId: event.sourceSelectorId,
      reporterMaterializationRef: {
        machineId: 'machine-1', materializationId: 'materialization-1', pluginId: event.eventRef.pluginId,
      },
      reporterImmutableGenerationId: 'generation-1',
      state: 'attention' as const,
      code: 'historyGap' as const,
      lastObservedAt: timestamp,
      lastDispositionAt: timestamp,
      nextRetryAt: null,
      observedCount: 4,
      admittedCount: 3,
      skippedCount: 1,
      revision: 7,
    };
    const withStatus = { ...listDefinition, triggers: [{ ...event, sourceStatus: status }] };
    expect(Api.AutomationDefinitionListItemSchema.parse(withStatus)).toMatchObject({
      triggers: [{ sourceStatus: { triggerId: event.id, triggerRevision: event.revision } }],
    });
    const { sourceStatus: _sourceStatus, ...missingStatus } = event;
    expect(Api.AutomationDefinitionListItemSchema.safeParse({
      ...listDefinition,
      triggers: [missingStatus],
    }).success).toBe(false);
    const { sourceCatalogStatus: _catalogStatus, ...missingCatalogStatus } = event;
    expect(Api.AutomationDefinitionListItemSchema.safeParse({
      ...listDefinition,
      triggers: [missingCatalogStatus],
    }).success).toBe(false);
    expect(Api.AutomationDefinitionListItemSchema.safeParse({
      ...withStatus,
      triggers: [{ ...event, sourceStatus: { ...status, providerCursor: 'private' } }],
    }).success).toBe(false);
  });

  it('uses the sole immutable cause and keeps retired-trigger history readable', () => {
    expect(Api.AutomationSessionLifecycleTriggerStatusSchema.safeParse({
      state: 'retired',
      runId: null,
    }).success).toBe(false);
    expect(Api.AutomationDefinitionListItemSchema.parse(listDefinition).retiredTriggers)
      .toEqual(listDefinition.retiredTriggers);
    expect(Api.AutomationV3RunListItemSchema.parse(run)).toEqual(run);
    expect(Api.AutomationV3RunListItemSchema.parse({
      ...run,
      triggerRetired: true,
    }).cause).toEqual(eventCause);
    expect(Api.AutomationV3RunListItemSchema.safeParse({
      ...run,
      triggerId: null,
      triggerRetired: true,
    }).success).toBe(false);
    expect(Api.AutomationV3RunListItemSchema.safeParse({ ...run, origin: eventCause }).success)
      .toBe(false);
    expect(Api.AutomationV3RunListItemSchema.safeParse({
      ...run,
      triggerId: 'different-trigger',
    }).success).toBe(false);
    expect(Api.AutomationV3RunListItemSchema.safeParse({
      ...run,
      cause: { kind: 'manual', invokedAt: timestamp },
    }).success).toBe(false);
    const detail = {
      ...run,
      triggerEvidenceEnvelope: '{"t":"plain","v":{"payload":"private"}}',
      executionInputEnvelope: '{"t":"plain","v":{"prompt":"private"}}',
      resultEnvelope: null,
      legacySummaryCiphertext: null,
      executionNativeRunId: null,
      executionNativeCallId: null,
      executionNativeSidechainId: null,
      events: [],
      errorDetailEnvelope: null,
    };
    expect(Api.AutomationV3RunDetailSchema.parse(detail)).toEqual(detail);
    expect(Api.AutomationV3RunDetailSchema.safeParse({
      ...detail,
      replyContextEnvelope: '{"opaque":"never disclose"}',
    }).success).toBe(false);
  });

  it('keeps current cause on worker claims while isolating released V2 frozen-input origin', () => {
    const currentness = { mode: 'plain' as const, version: 10, contentKeyFingerprint: null };
    const cause = { kind: 'manual' as const, invokedAt: timestamp };
    const input = {
      kind: 'happier_automation_run_execution_input_v1' as const,
      targetType: 'new_session' as const,
      templateVersion: 1,
      templateCiphertext,
      origin: { kind: 'manual' as const, invokedAt: timestamp },
    };
    const claim = {
      run: {
        id: 'run-1', automationId: 'automation-1', attempt: 1,
        executionInputEnvelope: JSON.stringify(input), triggerId: null, triggerRetired: false, cause,
      },
      automation: { id: 'automation-1', name: 'Daily summary', enabled: true },
      accountCurrentness: currentness,
    };
    expect(Api.AutomationRunExecutionInputV1Schema.parse(input)).toEqual(input);
    expect(Api.toAutomationRunExecutionInputV1Origin(cause)).toEqual(input.origin);
    expect(Api.toAutomationRunExecutionInputV1Origin({
      kind: 'trigger',
      triggerId: 'schedule-trigger',
      triggerRevision: 3,
      triggerKind: 'schedule',
      occurrenceKey,
      occurredAt: timestamp,
      evidence: { scheduledFor: timestamp },
    })).toEqual({ kind: 'scheduled', scheduledFor: timestamp });
    expect(Api.toAutomationRunExecutionInputV1Origin(eventCause)).toBeNull();
    expect(Api.AutomationRunExecutionInputV1Schema.safeParse({ ...input, cause }).success)
      .toBe(false);
    expect(Api.AutomationV3WorkerClaimResponseSchema.parse(claim)).toEqual(claim);
    expect(Api.AutomationV3WorkerClaimResponseSchema.safeParse({
      ...claim,
      run: { ...claim.run, triggerId: 'trigger-for-manual-cause' },
    }).success).toBe(false);
    expect(Api.AutomationV3WorkerClaimResponseSchema.safeParse({
      ...claim,
      run: { ...claim.run, origin: cause },
    }).success).toBe(false);
  });

  it('preserves settings, worker lifecycle, and history contracts', () => {
    const currentness = { mode: 'plain' as const, version: 10, contentKeyFingerprint: null };
    const settings = { maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' as const };
    const assignments = {
      settings: { maxActiveRunsPerMachine: 4 },
      assignments: [{ machineId: 'machine-1', automationId: listDefinition.id, nextClaimAt: timestamp }],
    };
    expect(Api.AutomationV3WorkerAssignmentsResponseSchema.parse(assignments)).toEqual(assignments);
    expect(Api.AutomationV3SettingsSchema.parse(settings)).toEqual(settings);
    expect(Api.AutomationV3SettingsUpdateRequestSchema.parse(settings)).toEqual(settings);
    expect(Api.DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE).toBe(4);
    expect(Api.DEFAULT_AUTOMATION_V3_RUN_RETENTION).toBe('thirtyDays');

    const start = { machineId: 'machine-1', attempt: 1, accountCurrentness: currentness };
    expect(Api.AutomationV3WorkerStartRequestSchema.parse(start)).toEqual(start);
    expect(Api.AutomationV3WorkerStartResponseSchema.parse({ run, accountCurrentness: currentness }))
      .toEqual({ run, accountCurrentness: currentness });
    expect(Api.AutomationV3WorkerSucceedRequestSchema.parse({
      ...start,
      producedSessionId: 'session-1',
      resultEnvelope: '{"t":"plain","v":{"text":"done"}}',
    })).toMatchObject({ producedSessionId: 'session-1' });
    expect(Api.AutomationV3WorkerFailRequestSchema.parse({
      ...start,
      errorCode: 'invalid_template',
    })).toMatchObject({ errorCode: 'invalid_template' });
    expect(Api.AutomationV3WorkerExecutionDispatchSettlementRequestSchema.parse({
      ...start,
      outcome: {
        kind: 'started', runId: 'native-run-1', callId: 'native-call-1',
        sidechainId: 'native-sidechain-1',
      },
    })).toMatchObject({ outcome: { kind: 'started' } });
    expect(Api.AutomationV3WorkerHeartbeatRequestSchema.safeParse(start).success).toBe(false);
    expect(Api.AutomationV3ClearRunHistoryResponseSchema.parse({ clearedRuns: 2 }))
      .toEqual({ clearedRuns: 2 });
    expect(Api.AutomationV3ClearRunHistoryResponseSchema.safeParse({ clearedRuns: -1 }).success)
      .toBe(false);
  });
});
