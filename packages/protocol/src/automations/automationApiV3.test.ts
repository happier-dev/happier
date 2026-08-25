import { describe, expect, it } from 'vitest';
import * as AutomationApiV3 from './automationApiV3.js';
import { AutomationRunReplyHandoffStateV1Schema } from './automationEventV1.js';

import {
  AutomationApiV2Schema,
  AutomationRunApiV2Schema,
  AutomationRunExecutionInputV1Schema,
  AutomationDefinitionDetailSchema,
  AutomationDefinitionListItemSchema,
  AutomationV3ClearRunHistoryResponseSchema,
  AutomationManualDefinitionCreateRequestSchema,
  AutomationPluginEventDefinitionCreateRequestSchema,
  AutomationPluginEventDefinitionPatchRequestSchema,
  AutomationV3SettingsSchema,
  AutomationV3SettingsUpdateRequestSchema,
  AutomationV3WorkerClaimResponseSchema,
  AutomationV3WorkerAssignmentsResponseSchema,
  AutomationV3WorkerExecutionDispatchSettlementRequestSchema,
  AutomationV3WorkerFailRequestSchema,
  AutomationV3WorkerHeartbeatRequestSchema,
  AutomationV3WorkerStartRequestSchema,
  AutomationV3WorkerStartResponseSchema,
  AutomationV3WorkerSucceedRequestSchema,
  AutomationV3RunDetailSchema,
  AutomationScheduleDefinitionCreateRequestSchema,
  AutomationV3RunListItemSchema,
  DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
  DEFAULT_AUTOMATION_V3_RUN_RETENTION,
} from './automationApiV3.js';

const timestamp = 1_786_257_600_000;

const v2Definition = {
  id: 'automation-1',
  name: 'Daily summary',
  description: null,
  enabled: true,
  schedule: {
    kind: 'interval',
    scheduleExpr: null,
    everyMs: 60_000,
    timezone: null,
  },
  targetType: 'new_session',
  templateCiphertext: '{"kind":"happier_automation_template_plain_v1"}',
  templateVersion: 1,
  nextRunAt: timestamp,
  lastRunAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
};

const v2Run = {
  id: 'run-1',
  automationId: 'automation-1',
  state: 'queued',
  scheduledAt: timestamp,
  dueAt: timestamp,
  claimedAt: null,
  startedAt: null,
  finishedAt: null,
  claimedByMachineId: null,
  leaseExpiresAt: null,
  attempt: 0,
  summaryCiphertext: null,
  errorCode: null,
  errorMessage: null,
  producedSessionId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const v3EventDefinition = {
  id: 'automation-event',
  name: 'Issue opened',
  description: null,
  enabled: true,
  trigger: {
    kind: 'pluginEvent',
    eventRef: { pluginId: 'com.example.github', localId: 'issue/opened' },
    sourceSelectorId: 'selector-1',
    sourceContractVersion: 2,
    observation: {
      kind: 'durablePush',
      webhookEndpointId: 'endpoint-1',
      observationStartsAt: timestamp,
    },
  },
  targetType: 'newSession',
  existingSessionId: null,
  templateCiphertext: '{"kind":"happier_automation_template_plain_v1"}',
  templateVersion: 2,
  triggerDefinitionEnvelope: '{"t":"plain","v":{"private":"source"}}',
  nextRunAt: null,
  lastRunAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
};

const currentScheduleRecipe = {
  v: 1,
  templateVersion: 3,
  template: {
    t: 'plain' as const,
    v: { v: 1, prompt: 'Run the current task.' },
  },
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

const v3CurrentScheduleDefinition = {
  id: 'automation-current',
  name: 'Current task',
  description: null,
  enabled: true,
  trigger: {
    kind: 'schedule' as const,
    schedule: {
      kind: 'interval' as const,
      scheduleExpr: null,
      everyMs: 60_000,
      timezone: null,
    },
  },
  targetType: 'executionRun' as const,
  existingSessionId: null,
  executionRecipe: currentScheduleRecipe,
  templateVersion: 3,
  triggerDefinitionEnvelope: null,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  assignments: [{ machineId: 'machine-1', enabled: true, priority: 0, updatedAt: timestamp }],
};

const v3EventRun = {
  id: 'run-event',
  automationId: 'automation-event',
  state: 'queued',
  origin: {
    kind: 'pluginEvent',
    occurrenceKey: 'occurrence-1',
    sourceSelectorId: 'selector-1',
    occurredAt: timestamp,
  },
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
  replyHandoffState: 'none',
  replyHandoffAttempt: 0,
  replyHandoffDueAt: null,
  contentRemovedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe('Automation versioned API schemas', () => {
  it('keeps the V1 and V3 reply-handoff exports on one Protocol leaf', () => {
    expect(AutomationApiV3.AutomationReplyHandoffStateV3Schema)
      .toBe(AutomationRunReplyHandoffStateV1Schema);
  });
  it('exposes only explicit V3 definition list and detail contracts', () => {
    expect(AutomationApiV3).not.toHaveProperty('AutomationV3DefinitionSchema');
  });

  it('accepts a manual-only definition without schedule or event machinery', () => {
    const input = {
      name: 'On demand task',
      enabled: true,
      trigger: { kind: 'manual' as const },
      executionRecipe: currentScheduleRecipe,
    };

    expect(AutomationManualDefinitionCreateRequestSchema.parse(input)).toEqual(
      expect.objectContaining({ name: input.name, trigger: input.trigger }),
    );
    const {
      executionRecipe: _executionRecipe,
      triggerDefinitionEnvelope: _triggerDefinitionEnvelope,
      ...listItem
    } = v3CurrentScheduleDefinition;
    expect(AutomationDefinitionListItemSchema.parse({
      ...listItem,
      trigger: { kind: 'manual' },
      nextRunAt: null,
    }).trigger).toEqual({ kind: 'manual' });
  });

  it('accepts only the strict first plugin-Event authoring contract', () => {
    const create = {
      name: 'Repository updates',
      description: null,
      enabled: true,
      trigger: {
        kind: 'pluginEvent',
        eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
        sourceInstanceId: 'github:repository:1234',
        sourceContractVersion: 1,
        sourceConfig: { credentialRef: 'github:account:1', repository: 'happier-dev/happier' },
        displayLabel: 'happier-dev/happier',
        observationTransport: {
          kind: 'checkpointedPull',
          watcherMaterializationRef: {
            machineId: 'machine-1',
            materializationId: 'materialization-1',
            pluginId: 'happier.scm.github',
          },
        },
        filter: null,
        maximumObservationAgeMs: 60_000,
      },
      executionRecipe: {
        ...currentScheduleRecipe,
        templateVersion: 1,
      },
      assignments: [{ machineId: 'machine-1' }],
    };
    expect(AutomationPluginEventDefinitionCreateRequestSchema.parse(create)).toMatchObject({
      ...create,
      executionRecipe: expect.objectContaining({ templateVersion: 1 }),
    });
    expect(AutomationPluginEventDefinitionPatchRequestSchema.parse({
      ...create,
      expectedTemplateVersion: 1,
    })).toMatchObject({ ...create, expectedTemplateVersion: 1,
      executionRecipe: expect.objectContaining({ templateVersion: 1 }),
    });

    for (const forbidden of [
      'sourceSelectorId',
      'triggerDefinitionEnvelope',
      'eventSourceDefinitionsRevision',
      'machineInstallationId',
      'catalogRevision',
      'providerPayload',
    ]) {
      expect(AutomationPluginEventDefinitionCreateRequestSchema.safeParse({
        ...create,
        trigger: { ...create.trigger, [forbidden]: 'caller-controlled' },
      }).success).toBe(false);
    }
    expect(AutomationPluginEventDefinitionCreateRequestSchema.safeParse({
      ...create,
      unknown: true,
    }).success).toBe(false);
    expect(AutomationPluginEventDefinitionPatchRequestSchema.safeParse(create).success).toBe(false);
  });

  it('accepts the durable-push authoring arm without any server-owned endpoint fact', () => {
    const pushTrigger = {
      kind: 'pluginEvent',
      eventRef: { pluginId: 'happier.scm.github', localId: 'repository-event-v1' },
      sourceInstanceId: 'github:repository:1234',
      sourceContractVersion: 1,
      sourceConfig: { credentialRef: 'github:account:1', repository: 'happier-dev/happier' },
      displayLabel: 'happier-dev/happier',
      observationTransport: {
        kind: 'durablePush',
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        endpointMaterializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.scm.github',
        },
        webhookRoutingSourceInstanceId: 'github:installation:2200',
        setup: { kind: 'githubAccountEndpointV1', credential: 'serverGenerated' },
      },
      filter: null,
      maximumObservationAgeMs: 60_000,
    };
    const create = {
      name: 'Repository webhooks',
      description: null,
      enabled: true,
      trigger: pushTrigger,
      executionRecipe: { ...currentScheduleRecipe, templateVersion: 1 },
      assignments: [{ machineId: 'machine-1' }],
    };
    expect(
      AutomationPluginEventDefinitionCreateRequestSchema.parse(create).trigger.observationTransport,
    ).toEqual(pushTrigger.observationTransport);
    expect(AutomationPluginEventDefinitionPatchRequestSchema.parse({
      ...create,
      expectedTemplateVersion: 1,
    }).trigger.observationTransport).toEqual(pushTrigger.observationTransport);

    // Server-owned endpoint facts and the other transport arm's watcher are
    // never accepted from an authoring client.
    for (const forbidden of [
      { observationStartsAt: timestamp },
      { webhookContribution: { pluginId: 'happier.scm.github', localId: 'github-events' } },
      {
        watcherMaterializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.scm.github',
        },
      },
    ]) {
      expect(AutomationPluginEventDefinitionCreateRequestSchema.safeParse({
        ...create,
        trigger: {
          ...pushTrigger,
          observationTransport: { ...pushTrigger.observationTransport, ...forbidden },
        },
      }).success).toBe(false);
    }

    // The endpoint scalar keeps its canonical 128-bit identity shape, and the
    // push arm may not omit the routing source or setup identity.
    expect(AutomationPluginEventDefinitionCreateRequestSchema.safeParse({
      ...create,
      trigger: {
        ...pushTrigger,
        observationTransport: { ...pushTrigger.observationTransport, webhookEndpointId: 'endpoint-1' },
      },
    }).success).toBe(false);
    for (const omitted of ['webhookRoutingSourceInstanceId', 'setup'] as const) {
      const { [omitted]: _dropped, ...rest } = pushTrigger.observationTransport;
      expect(AutomationPluginEventDefinitionCreateRequestSchema.safeParse({
        ...create,
        trigger: { ...pushTrigger, observationTransport: rest },
      }).success).toBe(false);
    }
  });

  it('keeps exact predecessor V2 definition and scheduled/manual Run key sets', () => {
    expect(AutomationApiV2Schema.parse(v2Definition)).toEqual(v2Definition);
    expect(AutomationRunApiV2Schema.parse(v2Run)).toEqual(v2Run);

    expect(AutomationApiV2Schema.safeParse({ ...v2Definition, trigger: { kind: 'schedule' } }).success)
      .toBe(false);
    expect(AutomationRunApiV2Schema.safeParse({ ...v2Run, origin: { kind: 'manual' } }).success)
      .toBe(false);
  });

  it('separates the V3 list-safe Event definition from direct-reader private authoring detail', () => {
    const {
      triggerDefinitionEnvelope: _privateEnvelope,
      templateCiphertext: _legacyDefinition,
      ...listItem
    } = v3EventDefinition;
    const {
      triggerDefinitionEnvelope: _currentPrivateEnvelope,
      executionRecipe: _currentDefinition,
      ...currentListItem
    } = v3CurrentScheduleDefinition;

    expect(AutomationDefinitionListItemSchema.parse(listItem)).toEqual(listItem);
    expect(AutomationDefinitionListItemSchema.safeParse(v3EventDefinition).success).toBe(false);
    expect(AutomationDefinitionDetailSchema.parse(v3EventDefinition)).toEqual(v3EventDefinition);
    expect(AutomationDefinitionListItemSchema.parse(currentListItem)).toEqual(currentListItem);
    expect(AutomationDefinitionDetailSchema.parse(v3CurrentScheduleDefinition)).toMatchObject({
      ...v3CurrentScheduleDefinition,
      executionRecipe: {
        ...currentScheduleRecipe,
        target: {
          ...currentScheduleRecipe.target,
          request: {
            ...currentScheduleRecipe.target.request,
            backendTarget: {
              kind: 'backend',
              backendId: 'codex',
              sourceKind: 'built_in',
            },
          },
        },
      },
    });
    expect(AutomationDefinitionDetailSchema.safeParse({
      ...v3EventDefinition,
      schedule: v2Definition.schedule,
    }).success).toBe(false);
  });

  it('rejects the retired Conversation definition from both list and detail contracts', () => {
    const conversationDetail = {
      ...v3CurrentScheduleDefinition,
      trigger: { kind: 'conversation' as const },
      triggerDefinitionEnvelope: '{"t":"plain","v":{"private":"conversation"}}',
    };
    const {
      executionRecipe: _executionRecipe,
      triggerDefinitionEnvelope: _triggerDefinitionEnvelope,
      ...conversationListItem
    } = conversationDetail;

    expect(AutomationDefinitionListItemSchema.safeParse(conversationListItem).success).toBe(false);
    expect(AutomationDefinitionDetailSchema.safeParse(conversationDetail).success).toBe(false);
  });

  it('projects only the current Event source-status row through the incumbent definition contracts', () => {
    const sourceSelectorId = '9d5af559-2c82-4c22-b6a0-ecabce38a631';
    const event = {
      ...v3EventDefinition,
      trigger: {
        ...v3EventDefinition.trigger,
        sourceSelectorId,
      },
      sourceStatus: {
        automationId: 'automation-event',
        eventRef: { pluginId: 'com.example.github', localId: 'issue/opened' },
        sourceSelectorId,
        templateVersion: 2,
        reporterMaterializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.example.github',
        },
        state: 'attention',
        code: 'historyGap',
        lastObservedAt: timestamp,
        lastDispositionAt: timestamp,
        nextRetryAt: null,
        observedCount: 4,
        admittedCount: 3,
        skippedCount: 1,
        revision: 7,
      },
    } as const;
    const {
      triggerDefinitionEnvelope: _privateEnvelope,
      templateCiphertext: _legacyDefinition,
      ...listItem
    } = event;

    expect(AutomationDefinitionListItemSchema.parse(listItem)).toMatchObject({
      sourceStatus: { state: 'attention', code: 'historyGap', revision: 7 },
    });
    expect(AutomationDefinitionDetailSchema.parse(event)).toMatchObject({
      sourceStatus: { reporterMaterializationRef: { materializationId: 'materialization-1' } },
    });
    expect(AutomationDefinitionListItemSchema.safeParse({
      ...listItem,
      sourceStatus: { ...event.sourceStatus, providerCursor: 'must-not-leak' },
    }).success).toBe(false);
  });

  it('keeps Event catalog reconciliation status bounded to safe revision and timing facts', () => {
    const sourceCatalogStatus = {
      observedRevision: '9',
      adoptedRevision: '7',
      state: 'reconciliationLate',
      scanStartedAt: timestamp,
      nextRetryAt: timestamp + 60_000,
    } as const;
    const event = {
      ...v3EventDefinition,
      sourceCatalogStatus,
    } as const;
    const {
      triggerDefinitionEnvelope: _privateEnvelope,
      templateCiphertext: _legacyDefinition,
      ...listItem
    } = event;

    expect(AutomationDefinitionListItemSchema.parse(listItem)).toMatchObject({
      sourceCatalogStatus,
    });
    expect(AutomationDefinitionDetailSchema.parse(event)).toMatchObject({
      sourceCatalogStatus,
    });

    for (const privateField of [
      { accountId: 'account-1' },
      { eventPluginId: 'com.example.github' },
      { reporterMaterializationRef: { machineId: 'machine-1' } },
      { scopeKey: 'durablePush:endpoint-1' },
      { providerCursor: 'must-not-leak' },
      { sourceConfig: { repository: 'private' } },
    ]) {
      expect(AutomationDefinitionListItemSchema.safeParse({
        ...listItem,
        sourceCatalogStatus: { ...sourceCatalogStatus, ...privateField },
      }).success).toBe(false);
    }

    expect(AutomationDefinitionListItemSchema.safeParse({
      ...v3CurrentScheduleDefinition,
      sourceCatalogStatus,
    }).success).toBe(false);
  });

  it('keeps V3 Run lists bounded while exact detail exposes direct private envelopes', () => {
    const privateFailureEnvelope = JSON.stringify({
      t: 'plain',
      v: {
        v: 1,
        correspondence: { automationId: 'automation-event', runId: 'run-event-1' },
        detail: 'private',
      },
    });
    expect(AutomationV3RunListItemSchema.parse(v3EventRun)).toEqual(v3EventRun);
    expect(AutomationV3RunListItemSchema.parse({
      ...v3EventRun,
      contentRemovedAt: timestamp,
    })).toEqual({
      ...v3EventRun,
      contentRemovedAt: timestamp,
    });
    const { contentRemovedAt: _contentRemovedAt, ...missingContentRemovedAt } = v3EventRun;
    expect(AutomationV3RunListItemSchema.safeParse(missingContentRemovedAt).success).toBe(false);
    expect(AutomationV3RunListItemSchema.safeParse({
      ...v3EventRun,
      errorMessage: 'private provider detail',
    }).success).toBe(false);
    expect(AutomationV3RunListItemSchema.safeParse({
      ...v3EventRun,
      resultEnvelope: '{"t":"plain","v":{"text":"private"}}',
    }).success).toBe(false);
    expect(AutomationV3RunListItemSchema.safeParse({
      ...v3EventRun,
      errorDetailEnvelope: privateFailureEnvelope,
    }).success).toBe(false);

    const detail = {
      ...v3EventRun,
      triggerEvidenceEnvelope: '{"t":"plain","v":{"payload":"private"}}',
      executionInputEnvelope: '{"t":"plain","v":{"prompt":"private"}}',
      resultEnvelope: '{"t":"plain","v":{"text":"private"}}',
      legacySummaryCiphertext: null,
      executionNativeRunId: null,
      executionNativeCallId: null,
      executionNativeSidechainId: null,
      events: [],
      errorDetailEnvelope: privateFailureEnvelope,
    };
    expect(AutomationV3RunDetailSchema.parse(detail)).toEqual(detail);
    expect(AutomationV3RunDetailSchema.safeParse({
      ...detail,
      replyContextEnvelope: '{"t":"plain","v":{"opaque":"never disclose"}}',
    }).success).toBe(false);
    expect(AutomationV3RunDetailSchema.safeParse({
      ...detail,
      replyHandoffReceiptEnvelope: '{"t":"plain","v":{"receipt":"never disclose"}}',
    }).success).toBe(false);
  });

  it('projects a durable claim wake separately from the bounded definition payload', () => {
    const settings = {
      maxActiveRunsPerMachine: 4,
      runRetention: 'thirtyDays' as const,
    };
    const response = {
      settings: { maxActiveRunsPerMachine: settings.maxActiveRunsPerMachine },
      assignments: [{
        machineId: 'machine-1',
        automationId: 'automation-event',
        nextClaimAt: timestamp,
      }],
    };
    expect(AutomationV3WorkerAssignmentsResponseSchema.parse(response)).toEqual(response);
    expect(AutomationV3WorkerAssignmentsResponseSchema.safeParse({
      assignments: [{ ...response.assignments[0], automation: v3EventDefinition }],
    }).success).toBe(false);
    expect(AutomationV3SettingsSchema.parse(settings)).toEqual(settings);
    expect(AutomationV3SettingsUpdateRequestSchema.parse(settings)).toEqual(settings);
    expect(AutomationV3SettingsSchema.safeParse({
      ...settings,
      maxActiveRunsPerMachine: 0,
    }).success).toBe(false);
    expect(AutomationV3SettingsSchema.safeParse({
      ...settings,
      runRetention: 'forever',
    }).success).toBe(false);
    expect(AutomationV3SettingsUpdateRequestSchema.safeParse({
      ...settings,
      unexpected: true,
    }).success).toBe(false);
    expect(DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE).toBe(4);
    expect(DEFAULT_AUTOMATION_V3_RUN_RETENTION).toBe('thirtyDays');
  });

  it('keeps a clear-history result bounded and explicit', () => {
    expect(AutomationV3ClearRunHistoryResponseSchema.parse({ clearedRuns: 2 }))
      .toEqual({ clearedRuns: 2 });
    expect(AutomationV3ClearRunHistoryResponseSchema.safeParse({ clearedRuns: -1 }).success)
      .toBe(false);
    expect(AutomationV3ClearRunHistoryResponseSchema.safeParse({ clearedRuns: 1, extra: true }).success)
      .toBe(false);
  });


  it('keeps current V3 schedule writes and worker settlement distinct from predecessor V2 payloads', () => {
    const create = {
      name: 'Daily summary',
      enabled: true,
      trigger: {
        kind: 'schedule',
        schedule: {
          kind: 'interval',
          scheduleExpr: null,
          everyMs: 60_000,
          timezone: null,
        },
      },
      executionRecipe: {
        v: 1,
        templateVersion: 1,
        template: {
          t: 'plain',
          v: { v: 1, prompt: 'Summarize the latest work.' },
        },
        triggerEvidence: null,
        target: { kind: 'existingSession', sessionId: 'session-1' },
      },
      assignments: [{ machineId: 'machine-1', enabled: true, priority: 0 }],
    };
    expect(AutomationScheduleDefinitionCreateRequestSchema.parse(create)).toEqual(create);
    expect(AutomationScheduleDefinitionCreateRequestSchema.safeParse({
      ...create,
      trigger: {
        kind: 'schedule',
        schedule: {
          ...create.trigger.schedule,
          everyMs: null,
        },
      },
    }).success).toBe(false);
    expect(AutomationScheduleDefinitionCreateRequestSchema.safeParse({
      ...create,
      trigger: {
        kind: 'schedule',
        schedule: {
          kind: 'cron',
          scheduleExpr: null,
          everyMs: null,
          timezone: null,
        },
      },
    }).success).toBe(false);
    expect(AutomationScheduleDefinitionCreateRequestSchema.safeParse({
      ...create,
      targetType: 'newSession',
      templateCiphertext: v2Definition.templateCiphertext,
    }).success).toBe(false);
    expect(AutomationScheduleDefinitionCreateRequestSchema.safeParse({
      ...create,
      executionRecipe: {
        ...create.executionRecipe,
        triggerEvidence: { t: 'plain', v: { v: 1, kind: 'conversation' } },
      },
    }).success).toBe(false);

    const currentness = {
      mode: 'plain',
      version: 10,
      contentKeyFingerprint: null,
    } as const;
    const claim = {
      run: {
        id: 'run-1',
        automationId: 'automation-1',
        attempt: 1,
        origin: { kind: 'manual', invokedAt: timestamp },
        executionInputEnvelope: JSON.stringify({
          kind: 'happier_automation_run_execution_input_v1',
          targetType: 'new_session',
          templateVersion: 1,
          templateCiphertext: v2Definition.templateCiphertext,
          origin: { kind: 'manual', invokedAt: timestamp },
        }),
      },
      automation: {
        id: 'automation-1',
        name: 'Daily summary',
        enabled: true,
      },
      accountCurrentness: currentness,
    };
    expect(AutomationV3WorkerClaimResponseSchema.parse(claim)).toEqual(claim);

    // A final Conversation reply needs the frozen correspondence at the
    // worker boundary; a V3 predecessor claim without that optional fact
    // remains a normal none-only claim.
    const finalResultClaim = {
      ...claim,
      run: {
        ...claim.run,
        resultDelivery: {
          kind: 'finalResult',
          accountId: 'account-1',
          handoffId: 'automation-reply-handoff:run-1',
        },
      },
    };
    expect(AutomationV3WorkerClaimResponseSchema.parse(finalResultClaim)).toEqual(finalResultClaim);
    expect(AutomationV3WorkerClaimResponseSchema.safeParse({
      ...finalResultClaim,
      run: {
        ...finalResultClaim.run,
        resultDelivery: {
          kind: 'finalResult',
          handoffId: 'automation-reply-handoff:run-1',
        },
      },
    }).success).toBe(false);
    expect(AutomationV3WorkerClaimResponseSchema.safeParse({
      ...finalResultClaim,
      run: {
        ...finalResultClaim.run,
        resultDelivery: { kind: 'executionRun' },
      },
    }).success).toBe(false);

    expect(AutomationV3WorkerClaimResponseSchema.safeParse({
      ...claim,
      accountCurrentness: null,
    }).success).toBe(false);
    expect(AutomationV3WorkerClaimResponseSchema.safeParse({
      ...claim,
      run: {
        ...claim.run,
        origin: undefined,
      },
    }).success).toBe(false);
    expect(AutomationV3WorkerClaimResponseSchema.safeParse({
      ...claim,
      automation: {
        ...claim.automation,
        targetType: 'newSession',
        templateCiphertext: v2Definition.templateCiphertext,
      },
    }).success).toBe(false);

    const frozenRecipe = {
      kind: 'happier_automation_run_execution_input_v1',
      targetType: 'new_session',
      templateVersion: 1,
      templateCiphertext: v2Definition.templateCiphertext,
      origin: {
        kind: 'pluginEvent',
        evidence: {
          v: 1,
          kind: 'pluginEvent',
          eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
          sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
          occurrenceId: 'delivery-1',
          occurredAt: timestamp,
          payload: { action: 'opened' },
        },
        sourceInstanceId: 'repository-acme-example',
        sourceContractVersion: 1,
        observationReceivedAt: timestamp + 1,
        filter: { version: 1, result: 'matched' },
      },
    } as const;
    expect(AutomationRunExecutionInputV1Schema.parse(frozenRecipe)).toEqual(frozenRecipe);
    expect(AutomationRunExecutionInputV1Schema.safeParse({
      ...frozenRecipe,
      origin: { ...frozenRecipe.origin, filter: { version: 1, result: 'filtered' } },
    }).success).toBe(false);
    expect(AutomationRunExecutionInputV1Schema.safeParse({
      kind: frozenRecipe.kind,
      targetType: frozenRecipe.targetType,
      templateCiphertext: frozenRecipe.templateCiphertext,
    }).success).toBe(false);

    const succeed = {
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: currentness,
      producedSessionId: 'session-1',
      resultEnvelope: '{"t":"plain","v":{"text":"done"}}',
    };
    expect(AutomationV3WorkerSucceedRequestSchema.parse(succeed)).toEqual(succeed);
    expect(AutomationV3WorkerSucceedRequestSchema.safeParse({
      ...succeed,
      summaryCiphertext: 'predecessor-only',
    }).success).toBe(false);

    const start = {
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: currentness,
    };
    expect(AutomationV3WorkerStartRequestSchema.parse(start)).toEqual(start);
    expect(AutomationV3WorkerStartRequestSchema.safeParse({
      machineId: 'machine-1',
      attempt: 1,
    }).success).toBe(false);
    expect(AutomationV3WorkerStartResponseSchema.parse({
      run: v3EventRun,
      accountCurrentness: currentness,
    })).toEqual({
      run: v3EventRun,
      accountCurrentness: currentness,
    });

    const fail = {
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: currentness,
      producedSessionId: 'session-known-after-cancellation',
      errorCode: 'invalid_template',
    };
    expect(AutomationV3WorkerFailRequestSchema.parse(fail)).toEqual(fail);
    const privateFailure = {
      ...fail,
      errorDetailEnvelope: '{"t":"plain","v":{"v":1,"correspondence":{"automationId":"automation-event","runId":"run-event-1"},"detail":"private"}}',
    };
    expect(AutomationV3WorkerFailRequestSchema.parse(privateFailure)).toEqual(privateFailure);
    expect(AutomationV3WorkerFailRequestSchema.safeParse({
      ...fail,
      errorMessage: 'raw private detail is not a V3 field',
    }).success).toBe(false);
    const dispatchSettlement = {
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: currentness,
      outcome: {
        kind: 'started' as const,
        runId: 'native-run-1',
        callId: 'native-call-1',
        sidechainId: 'native-sidechain-1',
        wait: { ok: false as const, code: 'timeout' as const },
      },
    };
    expect(AutomationV3WorkerExecutionDispatchSettlementRequestSchema.parse(dispatchSettlement))
      .toEqual(dispatchSettlement);
    expect(AutomationV3WorkerExecutionDispatchSettlementRequestSchema.safeParse({
      ...dispatchSettlement,
      outcome: {
        kind: 'noRunCreated',
        errorCode: 'execution_run_target_unavailable',
        retryable: true,
      },
    }).success).toBe(false);
    expect(AutomationV3WorkerHeartbeatRequestSchema.safeParse({
      machineId: 'machine-1',
      attempt: 1,
      accountCurrentness: currentness,
    }).success).toBe(false);
  });
});
