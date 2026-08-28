import { describe, expect, it } from 'vitest';

import {
  AutomationConversationActionHttpPathsV1,
  AutomationConversationActionHttpRequestSchemasV1,
  AutomationConversationActionOutputSchemasV1,
} from './automationEventV1.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';

const input = {
  automationId: 'automation-1',
  bindingId: 'binding-1',
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

const finalReplyHandoff = {
  actionRef: input.resultDelivery.actionRef,
  replyContextEnvelope: {
    t: 'plain',
    v: {
      v: 1,
      correspondence: {
        automationId: input.automationId,
        occurrenceKey: 'A'.repeat(43),
      },
      opaqueContext: input.resultDelivery.opaqueContext,
    },
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
        immutableGenerationId: 'generation-1',
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
    const { immutableGenerationId: _immutableGenerationId, ...unstampedCaller } = request.caller;
    expect(requests[actionId]!.safeParse({
      ...request,
      caller: unstampedCaller,
    }).success).toBe(false);
    expect(requests[actionId]!.safeParse({
      ...request,
      caller: { ...request.caller, machineId: 'caller-selected-machine' },
    }).success).toBe(false);
    // Binding a conversation delegates unattended execution to an external
    // sender, so the selector carries the Automation's nonsecret execution
    // consequences. It still carries no definition bytes, prompt, recipe,
    // watcher or schedule facts, and remains strict.
    const listedItem = {
      automationId: 'automation-1',
      label: 'Conversation target',
      execution: { targetType: 'execution_run', enabled: true },
    };
    expect(outputs[actionId]!.parse({
      items: [listedItem],
      nextCursor: null,
    })).toEqual({ items: [listedItem], nextCursor: null });
    expect(outputs[actionId]!.safeParse({
      items: [{ ...listedItem, targetType: 'execution_run' }],
      nextCursor: null,
    }).success).toBe(false);
    expect(outputs[actionId]!.safeParse({
      items: [{
        ...listedItem,
        execution: { ...listedItem.execution, templateCiphertext: 'secret' },
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(outputs[actionId]!.safeParse({
      items: [{ automationId: 'automation-1', label: 'Conversation target' }],
      nextCursor: null,
    }).success).toBe(false);
  });

  it('publishes the strict nondisclosing target-verification route with a generic stamped caller carrier', () => {
    const actionId = 'automation.conversation.target.verify';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        immutableGenerationId: 'generation-1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input: { automationId: 'automation-1' },
    } as const;

    expect(AutomationConversationActionHttpPathsV1[actionId]).toBe(
      '/v1/automations/conversation/target/verify',
    );
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse(request)).toEqual(request);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      input: { ...request.input, expectedTemplateVersion: 3 },
    }).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse({
      ...request,
      input: { ...request.input, resultDelivery: 'finalResult' },
    })).toEqual({
      ...request,
      input: { ...request.input, resultDelivery: 'finalResult' },
    });
    expect(AutomationConversationActionOutputSchemasV1[actionId].parse({
      kind: 'verified',
    })).toEqual({ kind: 'verified' });
    expect(AutomationConversationActionOutputSchemasV1[actionId].safeParse({
      kind: 'verified',
      templateVersion: 3,
    }).success).toBe(false);
    expect(AutomationConversationActionOutputSchemasV1[actionId].safeParse({
      kind: 'notVerified',
      reason: 'notFound',
      currentTemplateVersion: 4,
    }).success).toBe(false);
    expect(AutomationConversationActionOutputSchemasV1[actionId].parse({
      kind: 'notVerified',
      reason: 'resultDeliveryUnsupported',
    })).toEqual({
      kind: 'notVerified',
      reason: 'resultDeliveryUnsupported',
    });
    // Several bindings may name one target, so the verifier carries no
    // per-binding question and can publish no per-binding refusal.
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      input: { ...request.input, binding: { kind: 'exact', bindingId: 'binding-1' } },
    }).success).toBe(false);
    expect(AutomationConversationActionOutputSchemasV1[actionId].safeParse({
      kind: 'notVerified',
      reason: 'bindingMismatch',
    }).success).toBe(false);
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
    }).success).toBe(true);
  });

  it('publishes one strict signed caller frame and response map', () => {
    const actionId = 'automation.conversation.admit';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        immutableGenerationId: 'generation-1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input,
      replyHandoff: finalReplyHandoff,
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
    expect(AutomationConversationActionOutputSchemasV1[actionId].parse({
      kind: 'blocked',
      reason: 'resultDeliveryUnsupported',
      checkpointSafe: false,
    })).toEqual({
      kind: 'blocked',
      reason: 'resultDeliveryUnsupported',
      checkpointSafe: false,
    });
  });

  it('rejects caller-selected target authority and caller claims in the immutable input', () => {
    const actionId = 'automation.conversation.admit';
    const request = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        immutableGenerationId: 'generation-1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input,
      replyHandoff: finalReplyHandoff,
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
        immutableGenerationId: 'generation-1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      input,
    } as const;

    const noDeliveryRequest = {
      v: 1,
      caller: request.caller,
      input: { ...input, resultDelivery: { kind: 'none' } },
    } as const;
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse(noDeliveryRequest)).toEqual({
      ...noDeliveryRequest,
    });
    const { replyHandoff: _replyHandoff, ...missingHandoffRequest } = request;
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse(
      missingHandoffRequest,
    ).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      ...request,
      replyHandoff: {
        ...finalReplyHandoff,
        actionRef: { pluginId: 'happier.channels', localId: 'other-result-action' },
      },
    }).success).toBe(false);
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

  it('admits any plugin as the delivery target of the Conversation it admitted', () => {
    const actionId = 'automation.conversation.admit';
    const thirdPartyResultDelivery = {
      kind: 'finalResult' as const,
      actionRef: {
        pluginId: 'acme.slack-bridge',
        localId: 'automation/reply-deliver-v1',
      },
      opaqueContext: input.resultDelivery.opaqueContext,
    };
    const thirdPartyRequest = {
      v: 1,
      caller: {
        pluginId: 'acme.slack-bridge',
        contributionLocalId: 'slack/observation-ingest-v1',
        immutableGenerationId: 'generation-1',
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'acme.slack-bridge',
        },
      },
      input: {
        ...input,
        resultDelivery: thirdPartyResultDelivery,
      },
      replyHandoff: {
        actionRef: thirdPartyResultDelivery.actionRef,
        replyContextEnvelope: {
          t: 'plain',
          v: {
            v: 1,
            correspondence: {
              automationId: input.automationId,
              occurrenceKey: 'A'.repeat(43),
            },
            opaqueContext: input.resultDelivery.opaqueContext,
          },
        },
      },
    } as const;

    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse(thirdPartyRequest))
      .toEqual(thirdPartyRequest);
  });

  it('refuses a delivery target outside the admitting plugin so a reply cannot be misrouted', () => {
    const actionId = 'automation.conversation.admit';
    const thirdPartyCaller = {
      pluginId: 'acme.slack-bridge',
      contributionLocalId: 'slack/observation-ingest-v1',
      immutableGenerationId: 'generation-1',
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'acme.slack-bridge',
      },
    } as const;

    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].safeParse({
      v: 1,
      caller: thirdPartyCaller,
      // The bundled Channels target is not special: it is simply not this
      // caller's own contribution.
      input,
    }).success).toBe(false);
    expect(AutomationConversationActionHttpRequestSchemasV1[actionId].parse({
      v: 1,
      caller: thirdPartyCaller,
      input: { ...input, resultDelivery: { kind: 'none' } },
    })).toEqual({
      v: 1,
      caller: thirdPartyCaller,
      input: { ...input, resultDelivery: { kind: 'none' } },
    });
  });

  it('admits an encrypted Conversation body that structurally cannot carry plugin input', () => {
    const actionId = 'automation.conversation.admit';
    const requests = AutomationConversationActionHttpRequestSchemasV1 as Readonly<Record<string, {
      parse(value: unknown): unknown;
      safeParse(value: unknown): { success: boolean };
    }>>;
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(11) };
    const seal = (seed: number) => sealAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material,
      payload: { v: 1, seed },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + seed),
    });
    const caller = {
      pluginId: 'happier.channels',
      contributionLocalId: 'provider/observation-ingest-v1',
      immutableGenerationId: 'generation-1',
      materialization: {
        machineId: 'machine-1',
        materializationId: 'materialization-1',
        pluginId: 'happier.channels',
      },
    } as const;
    const hostEvidence = {
      v: 1,
      t: 'encrypted',
      accountCurrentness: { mode: 'e2ee', version: 4, contentKeyFingerprint: 'aemk1_content' },
      automationId: 'automation-1',
      occurrenceKey: 'A'.repeat(43),
      occurredAt: 1_700_000_000_000,
      triggerEvidenceEnvelope: { t: 'encrypted', c: seal(1) },
      executionTriggerEvidenceEnvelope: { t: 'encrypted', c: seal(9) },
      occurrenceEvidenceEqualityTag: `${'A'.repeat(42)}g`,
    } as const;
    const request = { v: 1, caller, hostEvidence } as const;

    expect(requests[actionId]!.parse(request)).toEqual(request);
    expect(requests[actionId]!.safeParse({
      ...request,
      hostEvidence: { ...hostEvidence, templateVersion: 3 },
    }).success).toBe(false);
    // No plaintext member may ride along with the sealed arm.
    expect(requests[actionId]!.safeParse({
      ...request,
      input: {
        automationId: 'automation-1',
        bindingId: 'binding-1',
        occurrenceId: 'telegram:update:1',
        occurredAt: 1_700_000_000_000,
        sender: { id: 'sender-1' },
        text: 'Please summarize the latest change.',
        resultDelivery: { kind: 'none' },
      },
    }).success).toBe(false);
    // Plain Account currentness cannot authorize a sealed body.
    expect(requests[actionId]!.safeParse({
      ...request,
      hostEvidence: {
        ...hostEvidence,
        accountCurrentness: { mode: 'plain', version: 4, contentKeyFingerprint: null },
      },
    }).success).toBe(false);
    // A ciphertext from another Account-scoped domain is not trigger evidence.
    expect(requests[actionId]!.safeParse({
      ...request,
      hostEvidence: {
        ...hostEvidence,
        triggerEvidenceEnvelope: {
          t: 'encrypted',
          c: sealAccountScopedBlobCiphertext({
            kind: 'automation_run_result',
            material,
            payload: { v: 1, kind: 'text', text: 'not evidence' },
            randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 3),
          }),
        },
      },
    }).success).toBe(false);
  });
});
