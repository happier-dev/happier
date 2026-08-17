import { describe, expect, it } from 'vitest';

import {
  AutomationConversationActionHttpPathsV1,
  AutomationConversationActionHttpRequestSchemasV1,
  AutomationConversationActionOutputSchemasV1,
} from './automationEventV1.js';

const input = {
  automationId: 'automation-1',
  bindingId: 'binding-1',
  templateVersion: 3,
  occurrenceId: 'telegram:update:1',
  occurredAt: 1_700_000_000_000,
  sender: { id: 'sender-1' },
  text: 'Please summarize the latest change.',
  resultDelivery: {
    kind: 'finalResult',
    actionRef: {
      pluginId: 'happier.channels',
      localId: 'automation/result-deliver-v1',
    },
    opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
  },
} as const;

describe('Automation conversation admission HTTP contract', () => {
  it('publishes the strict current-Channel target selector route without broad Automation fields', () => {
    const actionId = 'automation.conversation.targets.list';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input: { limit: 100, cursor: null },
    } as const;
    const paths = AutomationConversationActionHttpPathsV1 as Readonly<Record<string, string>>;
    const requests = AutomationConversationActionHttpRequestSchemasV1 as Readonly<Record<string, {
      parse(value: unknown): unknown;
      safeParse(value: unknown): { success: boolean };
    }>>;
    const outputs = AutomationConversationActionOutputSchemasV1 as Readonly<Record<string, {
      parse(value: unknown): unknown;
      safeParse(value: unknown): { success: boolean };
    }>>;

    expect(paths[actionId]).toBe('/v1/automations/conversation/targets/list');
    expect(requests[actionId]!.parse(request)).toEqual(request);
    expect(requests[actionId]!.safeParse({
      ...request,
      caller: { ...request.caller, machineId: 'caller-selected-machine' },
    }).success).toBe(false);
    expect(outputs[actionId]!.parse({
      items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' }],
      nextCursor: null,
    })).toEqual({
      items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' }],
      nextCursor: null,
    });
    expect(outputs[actionId]!.safeParse({
      items: [{
        automationId: 'automation-1',
        templateVersion: 3,
        label: 'Conversation target',
        targetType: 'execution_run',
      }],
      nextCursor: null,
    }).success).toBe(false);
  });

  it('publishes the strict nondisclosing target-verification route', () => {
    const actionId = 'automation.conversation.target.verify';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input: { automationId: 'automation-1', expectedTemplateVersion: 3 },
    } as const;

    expect(AutomationConversationActionHttpPathsV1[actionId]).toBe(
      '/v1/automations/conversation/target/verify',
    );
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse(request)).toEqual(request);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse({
      ...request,
      input: { ...request.input, resultDelivery: 'finalResult' },
    })).toEqual({
      ...request,
      input: { ...request.input, resultDelivery: 'finalResult' },
    });
    expect(AutomationConversationActionOutputSchemasV1[actionId].parse({
      kind: 'verified',
      templateVersion: 3,
    })).toEqual({ kind: 'verified', templateVersion: 3 });
    expect(AutomationConversationActionOutputSchemasV1[actionId].safeParse({
      kind: 'notVerified',
      reason: 'templateVersionMismatch',
      currentTemplateVersion: 4,
    }).success).toBe(false);
    expect(AutomationConversationActionOutputSchemasV1[actionId].parse({
      kind: 'notVerified',
      reason: 'resultDeliveryUnsupported',
    })).toEqual({
      kind: 'notVerified',
      reason: 'resultDeliveryUnsupported',
    });
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      caller: {
        ...request.caller,
        pluginId: 'com.acme.other',
        materialization: {
          ...request.caller.materialization,
          pluginId: 'com.acme.other',
        },
      },
    }).success).toBe(false);
  });

  it('publishes one strict signed caller frame and response map', () => {
    const actionId = 'automation.conversation.admit';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input,
    } as const;

    expect(AutomationConversationActionHttpPathsV1[actionId]).toBe(
      '/v1/automations/conversation/admit',
    );
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse(request)).toEqual(request);
    expect(AutomationConversationActionOutputSchemasV1[actionId].parse({
      kind: 'admitted',
      runId: 'run-1',
      checkpointSafe: true,
    })).toEqual({
      kind: 'admitted',
      runId: 'run-1',
      checkpointSafe: true,
    });
  });

  it('rejects caller-selected target authority and caller claims in the immutable input', () => {
    const actionId = 'automation.conversation.admit';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input,
    } as const;

    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      caller: { ...request.caller, machineId: 'caller-selected-machine' },
    }).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      caller: {
        ...request.caller,
        materialization: {
          ...request.caller.materialization,
          pluginId: 'com.acme.other',
        },
      },
    }).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      input: { ...input, caller: request.caller },
    }).success).toBe(false);
  });

  it('requires an explicit no-delivery or exact final-result delivery decision', () => {
    const actionId = 'automation.conversation.admit';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input,
    } as const;

    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse({
      ...request,
      input: { ...input, resultDelivery: { kind: 'none' } },
    })).toEqual({
      ...request,
      input: { ...input, resultDelivery: { kind: 'none' } },
    });
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      input: {
        ...input,
        resultDelivery: {
          actionRef: input.resultDelivery.actionRef,
          opaqueContext: input.resultDelivery.opaqueContext,
        },
      },
    }).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      input: {
        ...input,
        resultDelivery: {
          kind: 'finalResult',
          actionRef: input.resultDelivery.actionRef,
        },
      },
    }).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      input: {
        ...input,
        resultDelivery: {
          ...input.resultDelivery,
          actionRef: { pluginId: 'com.acme.other', localId: 'automation/result-deliver-v1' },
        },
      },
    }).success).toBe(false);
  });
});
