import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  isAutomationTriggerEvidenceCiphertextV1,
  openAutomationConversationReplyContextStoredEnvelopeV1,
  openAccountScopedBlobCiphertext,
  type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';

const transportMocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: transportMocks.post } }));
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: transportMocks.createPublisherHeader,
}));

import { createAutomationConversationActionExecutor } from './automationConversationActionExecutor';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

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
const callerMaterialization = {
  pluginId: 'happier.channels',
  machineId: 'machine-caller',
  materializationId: 'materialization-caller',
} as const;

const plainCurrentness: AccountEncryptionCurrentnessResponse = {
  mode: 'plain',
  version: 7,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1_700_000_000_000,
};

/**
 * The exact-reference revalidators the daemon supplies in production. The
 * durable admit arm reproves the stamped caller through them immediately
 * before transport; these fixtures model a caller that is still current.
 */
const currentCaller = {
  revalidateCallerMaterialization: async () => true,
  revalidateCallerImmutableGeneration: async () => true,
} as const;

/** The Account-mode boundary every admit call now resolves before it produces a body. */
const plainAccount = {
  resolveAccountId: async () => 'account-1',
  resolveAccountEncryptionCurrentness: async () => plainCurrentness,
  resolveAccountEncryptionMaterial: async () => null,
} as const;

function e2eeAccountFixture() {
  const content = tweetnacl.box.keyPair();
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: { type: 'dataKey', machineKey: content.secretKey },
    dataKeyPublicKey: content.publicKey,
  });
  const contentKeyFingerprint =
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      snapshot.contentPublicKeyFingerprint,
    );
  return {
    snapshot,
    contentKeyFingerprint,
    deps: {
      resolveAccountId: async () => 'account-1',
      resolveAccountEncryptionCurrentness: async (): Promise<AccountEncryptionCurrentnessResponse> => ({
        mode: 'e2ee',
        version: 9,
        signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint,
        updatedAt: 1_700_000_000_000,
      }),
      resolveAccountEncryptionMaterial: async () => snapshot,
      randomBytes: (length: number) => Uint8Array.from({ length }, (_, index) => index + 5),
    },
  };
}

describe('createAutomationConversationActionExecutor', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

  it('signs and sends the bounded target list only to the exact selector endpoint', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: {
        items: [{
          automationId: 'automation-1',
          templateVersion: 3,
          label: 'Conversation target',
          execution: { targetType: 'new_session', enabled: true },
        }],
        nextCursor: null,
      },
    });
    const listInput = { limit: 2, cursor: 'automation-0' } as const;
    const executor = createAutomationConversationActionExecutor({ credentials });

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: listInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      items: [{
          automationId: 'automation-1',
          templateVersion: 3,
          label: 'Conversation target',
          execution: { targetType: 'new_session', enabled: true },
        }],
      nextCursor: null,
    });

    const body = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      input: listInput,
    };
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/conversation/targets/list',
      body,
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/automations\/conversation\/targets\/list$/u),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'publisher-proof',
        }),
      }),
    );
  });

  it('honors cancellation before the target-list HTTP request', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancelled');
    controller.abort(cancellation);
    const executor = createAutomationConversationActionExecutor({ credentials });

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: {},
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect(transportMocks.createPublisherHeader).not.toHaveBeenCalled();
    expect(transportMocks.post).not.toHaveBeenCalled();
  });

  it('signs and sends target verification only to the exact verifier endpoint', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: { kind: 'verified', templateVersion: 3 },
    });
    const verifyInput = {
      automationId: 'automation-1',
      expectedTemplateVersion: 3,
    } as const;
    const executor = createAutomationConversationActionExecutor({
      credentials,
    });

    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: verifyInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });

    const body = {
      v: 1,
      caller: {
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      input: verifyInput,
    };
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/conversation/target/verify',
      body,
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/automations\/conversation\/target\/verify$/u),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'publisher-proof',
        }),
      }),
    );
  });

  it('transports target verification through the strict route with the same stamped caller and cancellation', async () => {
    const controller = new AbortController();
    const verifyInput = {
      automationId: 'automation-1',
      expectedTemplateVersion: 3,
    } as const;
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 3 }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: verifyInput,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });
    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        v: 1,
        caller: {
          pluginId: 'happier.channels',
          contributionLocalId: 'binding/create-v1',
          materialization: callerMaterialization,
        },
        input: verifyInput,
      },
      controller.signal,
    );
  });

  it('honors cancellation before the verifier HTTP request', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    const controller = new AbortController();
    const cancellation = new Error('cancelled');
    controller.abort(cancellation);
    const executor = createAutomationConversationActionExecutor({
      credentials,
    });

    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'binding/create-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).rejects.toBe(cancellation);
    expect(transportMocks.createPublisherHeader).not.toHaveBeenCalled();
    expect(transportMocks.post).not.toHaveBeenCalled();
  });

  it('forwards the host-stamped ingress materialization and cancellation without accepting target authority in input', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      ...currentCaller,
      ...plainAccount,
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
      signal: controller.signal,
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.admit',
      {
        v: 1,
        caller: {
          pluginId: 'happier.channels',
          contributionLocalId: 'provider/observation-ingest-v1',
          materialization: callerMaterialization,
        },
        input,
        replyHandoff: {
          actionRef: input.resultDelivery.actionRef,
          replyContextEnvelope: {
            t: 'plain',
            v: expect.objectContaining({
              v: 1,
              correspondence: {
                automationId: input.automationId,
                occurrenceKey: expect.any(String),
              },
              templateVersion: input.templateVersion,
              opaqueContext: input.resultDelivery.opaqueContext,
            }),
          },
        },
      },
      controller.signal,
    );
  });

  it('forwards a current host-stamped external plugin caller for generic conversation admission', async () => {
    const externalMaterialization = {
      ...callerMaterialization,
      pluginId: 'com.acme.other',
    } as const;
    const execute = vi.fn(async () => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      ...currentCaller,
      ...plainAccount,
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.other',
        contributionLocalId: 'observation-ingest-v1',
        materialization: externalMaterialization,
      },
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute).toHaveBeenCalledWith('automation.conversation.admit', {
      v: 1,
      caller: {
        pluginId: 'com.acme.other',
        contributionLocalId: 'observation-ingest-v1',
        materialization: externalMaterialization,
      },
      input,
      replyHandoff: {
        actionRef: input.resultDelivery.actionRef,
        replyContextEnvelope: {
          t: 'plain',
          v: expect.objectContaining({
            v: 1,
            correspondence: {
              automationId: input.automationId,
              occurrenceKey: expect.any(String),
            },
            templateVersion: input.templateVersion,
            opaqueContext: input.resultDelivery.opaqueContext,
          }),
        },
      },
    }, undefined);
  });

  it('fails closed before transport when the host-stamped caller materialization is absent', async () => {
    const execute = vi.fn();
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_caller_materialization_unavailable',
      error: 'automation_conversation_caller_materialization_unavailable',
    });
  });

  it('rejects a caller the host never stamped as a plugin before transport', async () => {
    const execute = vi.fn();
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
    });

    // The canonical executor already refuses a non-plugin caller for these
    // plugin-only Actions, so any frame reaching here is missing the exact
    // host-stamped contribution this transport must publish.
    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        },
      caller: { kind: 'host' } as never,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_caller_contribution_unavailable',
      error: 'automation_conversation_caller_contribution_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('drives the whole conversation flow for a third-party plugin that is not Channels', async () => {
    const thirdPartyMaterialization = {
      pluginId: 'acme.slack-bridge',
      machineId: 'machine-caller',
      materializationId: 'materialization-slack-1',
    } as const;
    const thirdPartyCaller = {
      kind: 'plugin',
      pluginId: 'acme.slack-bridge',
      contributionLocalId: 'slack/binding-v1',
      materialization: thirdPartyMaterialization,
    } as const;
    const stampedCaller = {
      pluginId: 'acme.slack-bridge',
      contributionLocalId: 'slack/binding-v1',
      materialization: thirdPartyMaterialization,
    } as const;
    const admitInput = {
      ...input,
      // `resultDelivery` stays `none` because the reply-handoff actionRef is
      // still pinned to `happier.channels` by the result-delivery schema.
      // Conversation participation itself is open to any host-stamped plugin.
      resultDelivery: { kind: 'none' },
    } as const;
    const execute = vi.fn(async (
      actionId: string,
      request: Readonly<{ caller: unknown }>,
    ) => {
      expect(request.caller).toEqual(stampedCaller);
      return actionId === 'automation.conversation.targets.list'
        ? { items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Target' }], nextCursor: null }
        : actionId === 'automation.conversation.target.verify'
          ? { kind: 'verified' as const, templateVersion: 3 }
          : { kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const };
    });
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      ...currentCaller,
      ...plainAccount,
    });

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: { limit: 2 },
      caller: thirdPartyCaller,
    })).resolves.toEqual({
      items: [{ automationId: 'automation-1', templateVersion: 3, label: 'Target' }],
      nextCursor: null,
    });
    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        },
      caller: thirdPartyCaller,
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });
    await expect(executor({
      actionId: 'automation.conversation.admit',
      input: admitInput,
      caller: thirdPartyCaller,
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
      'automation.conversation.targets.list',
      'automation.conversation.target.verify',
      'automation.conversation.admit',
    ]);
  });

  it('seals Conversation evidence for an E2EE Account so no plaintext reaches the wire', async () => {
    const account = e2eeAccountFixture();
    const execute = vi.fn(async (_actionId: string, _request: unknown) => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      ...currentCaller,
      ...account.deps,
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input: { ...input, resultDelivery: { kind: 'none' } },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });

    expect(execute).toHaveBeenCalledTimes(1);
    const call = execute.mock.calls[0]!;
    expect(call[0]).toBe('automation.conversation.admit');
    const request = call[1];
    // The encrypted arm is structurally incapable of carrying plugin input.
    expect(request).not.toHaveProperty('input');
    expect(JSON.stringify(request)).not.toContain(input.text);
    expect(JSON.stringify(request)).not.toContain('sender-1');
    expect(JSON.stringify(request)).not.toContain(input.bindingId);

    const hostEvidence = (request as { hostEvidence: unknown }).hostEvidence as {
      t: string;
      accountCurrentness: unknown;
      automationId: string;
      occurrenceKey: string;
      occurredAt: number;
      triggerEvidenceEnvelope: { t: string; c: string };
      executionTriggerEvidenceEnvelope: { t: string; c: string };
      occurrenceEvidenceEqualityTag: string;
    };
    expect(hostEvidence.t).toBe('encrypted');
    expect(hostEvidence.accountCurrentness).toEqual({
      mode: 'e2ee',
      version: 9,
      contentKeyFingerprint: account.contentKeyFingerprint,
    });
    expect(hostEvidence.automationId).toBe(input.automationId);
    expect(hostEvidence.occurredAt).toBe(input.occurredAt);
    expect(hostEvidence.occurrenceEvidenceEqualityTag).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(isAutomationTriggerEvidenceCiphertextV1(hostEvidence.triggerEvidenceEnvelope.c)).toBe(true);
    expect(
      isAutomationTriggerEvidenceCiphertextV1(hostEvidence.executionTriggerEvidenceEnvelope.c),
    ).toBe(true);

    // The Account key — and only the Account key — recovers the admitted message.
    const opened = openAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: account.snapshot.material,
      ciphertext: hostEvidence.triggerEvidenceEnvelope.c,
    });
    expect(opened?.value).toMatchObject({
      kind: 'conversation',
      bindingId: input.bindingId,
      occurrenceId: input.occurrenceId,
      input: { sender: input.sender, text: input.text },
    });
    const openedRunEvidence = openAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: account.snapshot.material,
      ciphertext: hostEvidence.executionTriggerEvidenceEnvelope.c,
    });
    expect(openedRunEvidence?.value).toMatchObject({
      kind: 'conversation',
      input: { sender: input.sender, text: input.text },
      observationReceivedAt: expect.any(Number),
    });
  });

  it('seals an E2EE finalResult handoff before admission without leaking its reply context', async () => {
    const account = e2eeAccountFixture();
    const execute = vi.fn(async (_actionId: string, _request: unknown) => ({
      kind: 'admitted' as const,
      runId: 'run-1',
      checkpointSafe: true as const,
    }));
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      ...currentCaller,
      ...account.deps,
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({ kind: 'admitted', runId: 'run-1', checkpointSafe: true });
    expect(execute).toHaveBeenCalledOnce();

    const request = execute.mock.calls[0]![1] as {
      hostEvidence: {
        occurrenceKey: string;
        replyHandoff?: {
          actionRef: unknown;
          replyContextEnvelope: unknown;
        };
      };
    };
    expect(request).not.toHaveProperty('input');
    expect(JSON.stringify(request)).not.toContain(input.resultDelivery.opaqueContext.conversationId);
    const replyHandoff = request.hostEvidence.replyHandoff;
    expect(replyHandoff?.actionRef).toEqual(input.resultDelivery.actionRef);
    if (!replyHandoff) throw new Error('Expected a sealed E2EE reply handoff');
    expect(openAutomationConversationReplyContextStoredEnvelopeV1({
      mode: 'e2ee',
      material: account.snapshot.material,
      envelope: replyHandoff.replyContextEnvelope,
    })).toEqual({
      kind: 'available',
      correspondence: {
        automationId: input.automationId,
        occurrenceKey: request.hostEvidence.occurrenceKey,
      },
      templateVersion: input.templateVersion,
      opaqueContext: input.resultDelivery.opaqueContext,
    });
  });

  it('refuses a plain admission whose caller materialization retires while Account work is in flight', async () => {
    const execute = vi.fn();
    let callerCurrent = true;
    const revalidateCallerMaterialization = vi.fn(async () => callerCurrent);
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      revalidateCallerImmutableGeneration: async () => true,
      resolveAccountId: plainAccount.resolveAccountId,
      // A reload retires the stamped caller while this host is still resolving
      // Account currentness for the admission it is about to send.
      resolveAccountEncryptionCurrentness: async () => {
        callerCurrent = false;
        return plainCurrentness;
      },
      resolveAccountEncryptionMaterial: plainAccount.resolveAccountEncryptionMaterial,
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input: { ...input, resultDelivery: { kind: 'none' } },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        immutableGenerationId: 'generation-caller',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_caller_materialization_unavailable',
      error: 'automation_conversation_caller_materialization_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(revalidateCallerMaterialization).toHaveBeenCalledWith(callerMaterialization);
  });

  it('refuses an E2EE admission whose caller generation retires while evidence is sealed', async () => {
    const account = e2eeAccountFixture();
    const execute = vi.fn();
    let generationCurrent = true;
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => generationCurrent,
      ...account.deps,
      // Account identity resolution precedes evidence construction and sealing;
      // the admitted generation is replaced while that work is in flight.
      resolveAccountId: async () => {
        generationCurrent = false;
        return 'account-1';
      },
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input: { ...input, resultDelivery: { kind: 'none' } },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        immutableGenerationId: 'generation-caller',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_caller_generation_unavailable',
      error: 'automation_conversation_caller_generation_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not make ordinary target reads acquire the durable admission fence', async () => {
    const execute = vi.fn(async (actionId: string) => (
      actionId === 'automation.conversation.targets.list'
        ? { items: [], nextCursor: null }
        : { kind: 'verified' as const, templateVersion: 3 }
    ));
    const revalidateCallerMaterialization = vi.fn(async () => false);
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      revalidateCallerImmutableGeneration: async () => false,
      ...plainAccount,
    });
    const caller = {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contributionLocalId: 'provider/observation-ingest-v1',
      immutableGenerationId: 'generation-caller',
      materialization: callerMaterialization,
    } as const;

    await expect(executor({
      actionId: 'automation.conversation.targets.list',
      input: { limit: 2 },
      caller,
    })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(executor({
      actionId: 'automation.conversation.target.verify',
      input: { automationId: 'automation-1', expectedTemplateVersion: 3 },
      caller,
    })).resolves.toEqual({ kind: 'verified', templateVersion: 3 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(revalidateCallerMaterialization).not.toHaveBeenCalled();
  });

  it('fails closed when Account currentness cannot be established for an admission', async () => {
    const execute = vi.fn();
    const executor = createAutomationConversationActionExecutor({
      credentials,
      transport: { execute },
      ...currentCaller,
      resolveAccountId: async () => 'account-1',
      resolveAccountEncryptionCurrentness: async () => {
        throw new Error('currentness unavailable');
      },
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(executor({
      actionId: 'automation.conversation.admit',
      input: { ...input, resultDelivery: { kind: 'none' } },
      caller: {
        kind: 'plugin',
        pluginId: 'happier.channels',
        contributionLocalId: 'provider/observation-ingest-v1',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_conversation_account_encryption_unavailable',
      error: 'automation_conversation_account_encryption_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
