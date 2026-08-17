import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import { ACTION_ID_FAMILIES_V1, ActionIdSchema, type ActionId } from './actionIds.js';
import {
  getActionSpec,
  PluginInvocableActionIdSchema,
  type PluginActionInputById,
  type PluginActionResultById,
  type PluginInvocableActionId,
} from './actionSpecs.js';
import {
  AUTOMATION_CONVERSATION_ACTION_IDS_V1,
  AUTOMATION_EVENT_ACTION_IDS_V1,
  AutomationConversationActionIdV1Schema,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  AutomationEventActionIdV1Schema,
  AutomationEventActionInputSchemasV1,
  AutomationEventActionOutputSchemasV1,
  type AutomationConversationActionIdV1,
  type AutomationEventActionIdV1,
} from '../automations/automationActionSpecsV1.js';
import {
  AUTOMATION_CONVERSATION_ACTION_IDS_V1 as legacyAutomationConversationActionIds,
  AUTOMATION_EVENT_ACTION_IDS_V1 as legacyAutomationEventActionIds,
  AutomationConversationActionIdV1Schema as legacyAutomationConversationActionIdSchema,
  AutomationConversationActionInputSchemasV1 as legacyAutomationConversationActionInputSchemas,
  AutomationConversationActionOutputSchemasV1 as legacyAutomationConversationActionOutputSchemas,
  AutomationEventActionIdV1Schema as legacyAutomationEventActionIdSchema,
  AutomationEventActionInputSchemasV1 as legacyAutomationEventActionInputSchemas,
  AutomationEventActionOutputSchemasV1 as legacyAutomationEventActionOutputSchemas,
} from '../automations/automationEventV1.js';

type AutomationActionIdV1 = Extract<ActionId, `automation.${string}`>;

describe('Event Automation ActionSpecs', () => {
  it('keeps the legacy Automation exports on the exact browser-safe Action packet', () => {
    expect(legacyAutomationEventActionIds).toBe(AUTOMATION_EVENT_ACTION_IDS_V1);
    expect(legacyAutomationConversationActionIds).toBe(AUTOMATION_CONVERSATION_ACTION_IDS_V1);
    expect(legacyAutomationEventActionIdSchema).toBe(AutomationEventActionIdV1Schema);
    expect(legacyAutomationConversationActionIdSchema).toBe(AutomationConversationActionIdV1Schema);
    expect(legacyAutomationEventActionInputSchemas).toBe(AutomationEventActionInputSchemasV1);
    expect(legacyAutomationEventActionOutputSchemas).toBe(AutomationEventActionOutputSchemasV1);
    expect(legacyAutomationConversationActionInputSchemas).toBe(AutomationConversationActionInputSchemasV1);
    expect(legacyAutomationConversationActionOutputSchemas).toBe(AutomationConversationActionOutputSchemasV1);
  });

  it('publishes only the three ready built-in Event Actions on the plugin surface', () => {
    expect(AUTOMATION_EVENT_ACTION_IDS_V1).toBe(ACTION_ID_FAMILIES_V1.automation_events);
    expect(AUTOMATION_CONVERSATION_ACTION_IDS_V1).toBe(ACTION_ID_FAMILIES_V1.automation_conversation);
    expect(AUTOMATION_EVENT_ACTION_IDS_V1).toEqual([
      'automation.event.sources.list',
      'automation.event.admit',
      'automation.event.source.status.report',
    ]);
    expect(AUTOMATION_CONVERSATION_ACTION_IDS_V1).toEqual([
      'automation.conversation.targets.list',
      'automation.conversation.target.verify',
      'automation.conversation.admit',
    ]);
    expect(ACTION_ID_FAMILIES_V1.automation_events).toEqual(AUTOMATION_EVENT_ACTION_IDS_V1);
    expectTypeOf<Extract<PluginInvocableActionId, AutomationEventActionIdV1>>()
      .toEqualTypeOf<AutomationEventActionIdV1>();
    expectTypeOf<AutomationActionIdV1>()
      .toEqualTypeOf<AutomationEventActionIdV1 | AutomationConversationActionIdV1>();
    expectTypeOf<Extract<PluginInvocableActionId, AutomationActionIdV1>>()
      .toEqualTypeOf<AutomationActionIdV1>();
    expectTypeOf<PluginActionInputById['automation.event.sources.list']>()
      .toEqualTypeOf<z.input<typeof AutomationEventActionInputSchemasV1['automation.event.sources.list']>>();
    expectTypeOf<PluginActionResultById['automation.event.sources.list']>()
      .toEqualTypeOf<z.output<typeof AutomationEventActionOutputSchemasV1['automation.event.sources.list']>>();
    expectTypeOf<PluginActionInputById['automation.event.admit']>()
      .toEqualTypeOf<z.input<typeof AutomationEventActionInputSchemasV1['automation.event.admit']>>();
    expectTypeOf<PluginActionResultById['automation.event.admit']>()
      .toEqualTypeOf<z.output<typeof AutomationEventActionOutputSchemasV1['automation.event.admit']>>();
    expectTypeOf<PluginActionInputById['automation.event.source.status.report']>()
      .toEqualTypeOf<z.input<typeof AutomationEventActionInputSchemasV1['automation.event.source.status.report']>>();
    expectTypeOf<PluginActionResultById['automation.event.source.status.report']>()
      .toEqualTypeOf<z.output<typeof AutomationEventActionOutputSchemasV1['automation.event.source.status.report']>>();

    for (const actionId of AUTOMATION_EVENT_ACTION_IDS_V1) {
      expect(ActionIdSchema.parse(actionId)).toBe(actionId);
      expect(PluginInvocableActionIdSchema.parse(actionId)).toBe(actionId);
      expect(getActionSpec(actionId).surfaces).toEqual(expect.objectContaining({
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        sdk: false,
        plugin: true,
      }));
    }
  });

  it('uses the strict Automation owner schemas without mutable host authority', () => {
    const sourceList = getActionSpec('automation.event.sources.list');
    expect(sourceList.inputSchema.safeParse({
      transport: { kind: 'checkpointedPull' },
      accountId: 'caller-controlled-account',
    }).success).toBe(false);

    const admit = getActionSpec('automation.event.admit');
    const eventAdmission = {
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      }],
    };
    expect(admit.inputSchema.safeParse(eventAdmission).success).toBe(true);
    for (const [field, value] of Object.entries({
      machineId: 'caller-controlled-machine',
      sessionId: 'source-selected-session',
      pendingLocalId: 'source-selected-pending',
      idempotencyKey: 'source-selected-idempotency-key',
      checkpoint: { sourceOwned: true },
    })) {
      expect(admit.inputSchema.safeParse({ ...eventAdmission, [field]: value }).success, field).toBe(false);
    }

    const status = getActionSpec('automation.event.source.status.report');
    expect(status.inputSchema.safeParse({
      kind: 'source',
      automationId: 'automation-1',
      templateVersion: 3,
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      state: 'observing',
      code: 'none',
      lastObservedAt: 1,
      lastDispositionAt: 1,
      nextRetryAt: null,
      observedDelta: 1,
      admittedDelta: 1,
      skippedDelta: 0,
      reporterMaterializationRef: { machineId: 'caller-controlled-machine' },
    }).success).toBe(false);
  });
});
