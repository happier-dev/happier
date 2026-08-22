import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import { ActionIdSchema } from './actionIds.js';
import {
  getActionSpec,
  PluginInvocableActionIdSchema,
  type PluginActionInputById,
  type PluginActionResultById,
  type PluginInvocableActionId,
} from './actionSpecs.js';
import {
  AutomationConversationAdmitInputV1Schema,
  AutomationConversationAdmitResultV1Schema,
  AutomationConversationTargetVerifyInputV1Schema,
  AutomationConversationTargetVerifyResultV1Schema,
} from '../automations/automationEventV1.js';

const conversationAdmitInput = {
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

describe('Automation conversation admission ActionSpec', () => {
  it('publishes the bounded target selector as a plugin-only safe read without result approval', () => {
    const actionId = 'automation.conversation.targets.list';
    const spec = getActionSpec(actionId as never);

    expect(ActionIdSchema.parse(actionId)).toBe(actionId);
    expect(PluginInvocableActionIdSchema.parse(actionId)).toBe(actionId);
    expect(spec).toEqual(expect.objectContaining({
      safety: 'safe',
      sideEffectClass: 'read',
      approval: { result: 'none' },
      pluginCallerPolicy: { kind: 'caller' },
    }));
    expect(spec.surfaces).toEqual({
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      plugin: true,
    });

    expect(spec.inputSchema.parse({})).toEqual({});
    expect(spec.inputSchema.parse({ limit: 100, cursor: null })).toEqual({ limit: 100, cursor: null });
    for (const invalidInput of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { cursor: '' },
      { cursor: 'a'.repeat(257) },
      { cursor: ' automation-1' },
      { cursor: 'automation-1', extra: true },
    ]) {
      expect(spec.inputSchema.safeParse(invalidInput).success).toBe(false);
    }

    const item = { automationId: 'automation-1', templateVersion: 3, label: 'Conversation target' };
    expect(spec.outputSchema.parse({ items: [item], nextCursor: null })).toEqual({
      items: [item],
      nextCursor: null,
    });
    expect(spec.outputSchema.safeParse({
      items: [item],
      nextCursor: null,
      enabled: true,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      items: [{ ...item, description: 'private' }],
      nextCursor: null,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      items: [{ ...item, label: '' }],
      nextCursor: null,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      items: [{ ...item, label: 'x'.repeat(257) }],
      nextCursor: null,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      items: [{ ...item, templateVersion: -1 }],
      nextCursor: null,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      items: [{ ...item, templateVersion: Number.MAX_SAFE_INTEGER + 1 }],
      nextCursor: null,
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({
      items: Array.from({ length: 101 }, (_, index) => ({
        automationId: `automation-${index}`,
        templateVersion: index,
        label: `Target ${index}`,
      })),
      nextCursor: null,
    }).success).toBe(false);
  });

  it('publishes the target verifier as a plugin-only read Action with exact typed results', () => {
    const actionId = 'automation.conversation.target.verify';

    expect(ActionIdSchema.parse(actionId)).toBe(actionId);
    expect(PluginInvocableActionIdSchema.parse(actionId)).toBe(actionId);
    expectTypeOf<Extract<PluginInvocableActionId, typeof actionId>>()
      .toEqualTypeOf<typeof actionId>();
    expectTypeOf<PluginActionInputById[typeof actionId]>()
      .toEqualTypeOf<z.input<typeof AutomationConversationTargetVerifyInputV1Schema>>();
    expectTypeOf<PluginActionResultById[typeof actionId]>()
      .toEqualTypeOf<z.output<typeof AutomationConversationTargetVerifyResultV1Schema>>();
    const spec = getActionSpec(actionId);
    expect(spec).toEqual(expect.objectContaining({
      safety: 'safe',
      sideEffectClass: 'read',
      surfaces: expect.objectContaining({ plugin: true }),
      approval: { result: 'none' },
      pluginCallerPolicy: { kind: 'caller' },
    }));
    expect(spec.surfaces).toEqual(expect.objectContaining({
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
    }));
  });

  it('admits only the exact bounded target verification input and nondisclosing result union', () => {
    const spec = getActionSpec('automation.conversation.target.verify');
    const input = {
      automationId: 'automation-1',
      expectedTemplateVersion: 3,
    } as const;

    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, expectedTemplateVersion: -1 }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, expectedTemplateVersion: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, templateVersion: 3 }).success).toBe(false);
    // A conversation is an additional invocation source, so several bindings
    // may name one target and the verifier asks no per-binding question.
    expect(spec.inputSchema.safeParse({ ...input, bindingId: 'binding-1' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({
      ...input,
      binding: { kind: 'exact', bindingId: 'binding-1' },
    }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ kind: 'notVerified', reason: 'bindingMismatch' }).success)
      .toBe(false);
    expect(spec.outputSchema.safeParse({ kind: 'notVerified', reason: 'notConversation' }).success)
      .toBe(false);
    expect(spec.outputSchema.parse({ kind: 'notVerified', reason: 'resultDeliveryUnsupported' }))
      .toEqual({ kind: 'notVerified', reason: 'resultDeliveryUnsupported' });
    expect(spec.outputSchema.parse({ kind: 'verified', templateVersion: 3 })).toEqual({
      kind: 'verified',
      templateVersion: 3,
    });
    expect(spec.outputSchema.parse({
      kind: 'notVerified',
      reason: 'templateVersionMismatch',
    })).toEqual({ kind: 'notVerified', reason: 'templateVersionMismatch' });
    expect(spec.outputSchema.safeParse({
      kind: 'notVerified',
      reason: 'templateVersionMismatch',
      currentTemplateVersion: 4,
    }).success).toBe(false);
  });

  it('publishes the strict conversation admission Action only on the plugin surface', () => {
    const actionId = 'automation.conversation.admit';

    expect(ActionIdSchema.parse(actionId)).toBe(actionId);
    expect(PluginInvocableActionIdSchema.parse(actionId)).toBe(actionId);
    expectTypeOf<Extract<PluginInvocableActionId, typeof actionId>>()
      .toEqualTypeOf<typeof actionId>();
    expectTypeOf<PluginActionInputById[typeof actionId]>()
      .toEqualTypeOf<z.input<typeof AutomationConversationAdmitInputV1Schema>>();
    expectTypeOf<PluginActionResultById[typeof actionId]>()
      .toEqualTypeOf<z.output<typeof AutomationConversationAdmitResultV1Schema>>();
    const spec = getActionSpec(actionId);
    expect(spec.surfaces).toEqual(expect.objectContaining({
      ui: false,
      voice: false,
      agent: false,
      mcp: false,
      cli: false,
      rpc: false,
      sdk: false,
      plugin: true,
    }));
    expect(spec.approval).toEqual({ result: 'none' });
    expect(spec.pluginCallerPolicy).toEqual({ kind: 'caller' });
  });

  it('rejects mutable caller or machine authority before the Automation owner', () => {
    const spec = getActionSpec('automation.conversation.admit');

    expect(spec.inputSchema.safeParse(conversationAdmitInput).success).toBe(true);
    expect(spec.inputSchema.safeParse({
      ...conversationAdmitInput,
      caller: { pluginId: 'happier.channels' },
    }).success).toBe(false);
    expect(spec.inputSchema.safeParse({
      ...conversationAdmitInput,
      machineId: 'caller-selected-machine',
    }).success).toBe(false);
  });
});
