import { describe, expect, it, vi } from 'vitest';

import {
  AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
  AutomationOccurrenceKeyV1Schema,
  AutomationReplyHandoffDispatchResultV1Schema,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  openAutomationReplyHandoffReceiptStoredEnvelopeV1,
  sealAutomationConversationReplyContextStoredEnvelopeV1,
  sealAutomationRunResultStoredEnvelopeV1,
  type AccountEncryptionCurrentnessResponse,
  type AccountScopedCryptoMaterialSnapshotV1,
} from '@happier-dev/protocol';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
  registerAutomationReplyHandoffRpcHandler,
  type AutomationReplyHandoffRpcRegistrationOptions,
} from './automationReplyHandoff';

const emptyContributions = {
  agents: [],
  actions: [],
  resources: [],
  activationTargets: [],
  catalogEntriesById: {},
  agentDefinitionsById: new Map<string, never>(),
  pluginDiagnosticsByPluginId: {},
} satisfies ResolvedContributionRegistry;

type AutomationReplyHandoffActionExecutor = NonNullable<
  AutomationReplyHandoffRpcRegistrationOptions['executeContributedAction']
>;
type AutomationReplyHandoffActionExecution = Awaited<
  ReturnType<AutomationReplyHandoffActionExecutor>
>;

const correspondence = {
  accountId: 'account-1',
  automationId: 'automation-1',
  runId: 'run-1',
  handoffId: 'handoff-1',
} as const;

const replyContextCorrespondence = {
  automationId: correspondence.automationId,
  occurrenceKey: AutomationOccurrenceKeyV1Schema.parse('A'.repeat(43)),
} as const;

const source = {
  kind: 'automationResult',
  automationRunId: correspondence.runId,
  resultId: correspondence.handoffId,
  automationId: correspondence.automationId,
  templateVersion: 3,
  resultDelivery: 'finalResult',
} as const;

const plainCurrentness: AccountEncryptionCurrentnessResponse = {
  mode: 'plain',
  version: 7,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
};

/**
 * A synthetic out-of-tree bridge. The reply-handoff receiver dispatches to the
 * frozen plugin's own declared Action contribution, so no first-party plugin id
 * is load-bearing on this path.
 */
const thirdPartyDeliveryActionRef = {
  pluginId: 'acme.slack-bridge',
  localId: 'automation/reply-deliver-v1',
} as const;

const request = {
  v: 1,
  kind: 'automation.replyHandoff.dispatch',
  target: {
    accountId: 'account-1',
    machineId: 'machine-1',
    machineInstallationId: 'installation-1',
    materializationId: 'materialization-1',
    actionRef: thirdPartyDeliveryActionRef,
  },
  handoff: {
    handoffId: correspondence.handoffId,
    runId: correspondence.runId,
    automationId: correspondence.automationId,
    occurrenceKey: replyContextCorrespondence.occurrenceKey,
    accountCurrentness: {
      mode: 'plain',
      version: plainCurrentness.version,
      contentKeyFingerprint: null,
    },
    resultEnvelope: {
      t: 'plain',
      v: {
        v: 1,
        correspondence,
        result: { v: 1, kind: 'text', text: 'Completed.' },
      },
    },
    replyContextEnvelope: {
      t: 'plain',
      v: {
        v: 1,
        correspondence: replyContextCorrespondence,
        templateVersion: source.templateVersion,
        opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
      },
    },
  },
} as const;

function deterministicRandomBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index + 1);
}

function e2eeSnapshot(fill: number): AccountScopedCryptoMaterialSnapshotV1 {
  return createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: { type: 'legacy', secret: new Uint8Array(32).fill(fill) },
  });
}

function e2eeCurrentness(
  snapshot: AccountScopedCryptoMaterialSnapshotV1,
  version: number,
): AccountEncryptionCurrentnessResponse {
  return {
    mode: 'e2ee',
    version,
    signingKeyFingerprint: 'aemk1_signing',
    contentKeyFingerprint:
      convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        snapshot.contentPublicKeyFingerprint,
      ),
    updatedAt: version,
  };
}

function createEncryptedRequest(
  snapshot: AccountScopedCryptoMaterialSnapshotV1,
  accountCurrentness = e2eeCurrentness(snapshot, 8),
) {
  return {
    ...request,
    handoff: {
      ...request.handoff,
      accountCurrentness: {
        mode: 'e2ee' as const,
        version: accountCurrentness.version,
        contentKeyFingerprint: accountCurrentness.contentKeyFingerprint,
      },
      resultEnvelope: sealAutomationRunResultStoredEnvelopeV1({
        mode: 'e2ee',
        correspondence,
        result: { v: 1, kind: 'text', text: 'Completed.' },
        material: snapshot.material,
        randomBytes: deterministicRandomBytes,
      }),
      replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
        mode: 'e2ee',
        correspondence: replyContextCorrespondence,
        templateVersion: source.templateVersion,
        opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
        material: snapshot.material,
        randomBytes: deterministicRandomBytes,
      }),
    },
  };
}

function createRegistrar(): Readonly<{
  handlers: Map<string, RpcHandler>;
  registrar: RpcHandlerRegistrar;
}> {
  const handlers = new Map<string, RpcHandler>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return {
    handlers,
    registrar,
  };
}

function createRuntimeRegistry(): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes: emptyContributions,
    resolvePromptAssetBlocks: async () => [],
    hookHandlersByHookId: new Map(),
    agentRuntimesByAgentId: new Map(),
    scmHostingProvidersById: new Map(),
    pluginDiagnosticsByPluginId: {},
    activatedPluginIds: new Set(),
    activateContributionsOnDemand: async () => [],
    addRuntimeDisposable: (_pluginId, disposable) => disposable,
    createAgentInvocationServices: async () => createUnavailablePluginServices(),
    resolveStructuredMessage: async () => {
      throw new Error('Structured-message resolution is unavailable in this fixture');
    },
    retireConsumers: () => {},
    dispose: async () => {},
  };
}

function createRuntimeLease(
  registry: ResolvedExecutablePluginRuntimeRegistry = createRuntimeRegistry(),
  release: () => Promise<void> = async () => {},
): PluginRuntimeRegistryLease {
  return { registry, source: 'active', release };
}

function createRegistration(overrides?: Readonly<{
  accountId?: string | null;
  machineId?: string;
  installationId?: string | null;
  materializationId?: string | null;
  execution?: AutomationReplyHandoffActionExecution;
  currentnessSequence?: readonly AccountEncryptionCurrentnessResponse[];
  materialSequence?: readonly (AccountScopedCryptoMaterialSnapshotV1 | null)[];
}>) {
  const { handlers, registrar } = createRegistrar();
  const registry = createRuntimeRegistry();
  const release = vi.fn(async () => {});
  const executeContributedAction = vi.fn<AutomationReplyHandoffActionExecutor>(async () => overrides?.execution ?? ({
    matched: true,
    result: { ok: true, result: { kind: 'accepted', custodyId: 'custody-1' } },
  }));
  const currentnessSequence = overrides?.currentnessSequence ?? [plainCurrentness];
  const materialSequence = overrides?.materialSequence ?? [null];
  let currentnessIndex = 0;
  let materialIndex = 0;
  const resolveAccountEncryptionCurrentness = vi.fn(async () =>
    currentnessSequence[Math.min(currentnessIndex++, currentnessSequence.length - 1)]!,
  );
  const resolveAccountEncryptionMaterial = vi.fn(async () =>
    materialSequence[Math.min(materialIndex++, materialSequence.length - 1)]!,
  );
  registerAutomationReplyHandoffRpcHandler(registrar, {
    machineId: overrides?.machineId ?? 'machine-1',
    resolveAccountId: async () => overrides?.accountId === undefined ? 'account-1' : overrides.accountId,
    resolveInstallationId: () => overrides?.installationId === undefined ? 'installation-1' : overrides.installationId,
    resolveAccountEncryptionCurrentness,
    resolveAccountEncryptionMaterial,
    // Production resolves the current materialization for the frozen target
    // plugin. Model that here so a substituted plugin id cannot borrow the
    // frozen materialization of the plugin that actually admitted.
    resolveCurrentTargetMaterializationId: async (pluginId) => {
      if (pluginId !== thirdPartyDeliveryActionRef.pluginId) return null;
      return overrides?.materializationId === undefined
        ? 'materialization-1'
        : overrides.materializationId;
    },
    acquireRuntimeLease: async () => createRuntimeLease(registry, release),
    executeContributedAction,
  });
  const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
  if (!handler) throw new Error('expected Automation reply-handoff RPC handler');
  return {
    handler,
    executeContributedAction,
    release,
    registry,
    resolveAccountEncryptionCurrentness,
    resolveAccountEncryptionMaterial,
  };
}

describe('registerAutomationReplyHandoffRpcHandler', () => {
  it('opens bound content locally, stamps automationRun caller/cancellation, and projects no custody detail', async () => {
    const controller = new AbortController();
    const { handler, executeContributedAction, release, registry } = createRegistration();

    await expect(handler(request, { signal: controller.signal })).resolves.toEqual({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
      receiptEnvelope: {
        t: 'plain',
        v: {
          v: 1,
          correspondence,
          result: { kind: 'accepted', custodyId: 'custody-1' },
        },
      },
    });

    expect(executeContributedAction).toHaveBeenCalledWith({
      runtimeRegistry: registry,
      actionId: 'acme.slack-bridge/automation/reply-deliver-v1',
      input: {
        v: 1,
        handoffId: 'handoff-1',
        runId: 'run-1',
        automationId: 'automation-1',
        source,
        result: { v: 1, kind: 'text', text: 'Completed.' },
        opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
      },
      context: {
        surface: 'plugin',
        invocationSurface: 'background',
        caller: {
          kind: 'automationRun',
          automationId: 'automation-1',
          runId: 'run-1',
          origin: 'conversation',
        },
        signal: controller.signal,
      },
    });
    const response = await handler(request, { signal: controller.signal });
    expect(executeContributedAction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: expect.objectContaining({
        handoffId: correspondence.handoffId,
        runId: correspondence.runId,
        automationId: correspondence.automationId,
        source,
        opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
      }),
      context: expect.objectContaining({
        caller: {
          kind: 'automationRun',
          automationId: correspondence.automationId,
          runId: correspondence.runId,
          origin: 'conversation',
        },
      }),
    }));
    expect(response).not.toHaveProperty('custodyId');
    expect(response).not.toHaveProperty('settlement.custodyId');
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong account', { accountId: 'account-2' }],
    ['wrong machine', { machineId: 'machine-2' }],
    ['wrong installation', { installationId: 'installation-2' }],
    ['retired materialization', { materializationId: 'materialization-2' }],
  ])('rejects %s before a plugin invocation', async (_label, overrides) => {
    const { handler, executeContributedAction } = createRegistration(overrides);

    await expect(handler(request)).resolves.toEqual({
      kind: 'unavailable',
      code: 'targetMismatch',
    });
    expect(executeContributedAction).not.toHaveBeenCalled();
  });

  it('does not pair a pre-reload target with a lease acquired after its materialization changed', async () => {
    const { handlers, registrar } = createRegistrar();
    let currentMaterializationId = 'materialization-1';
    const executeContributedAction = vi.fn<AutomationReplyHandoffActionExecutor>(async () => ({
      matched: true,
      result: { ok: true, result: { kind: 'accepted', custodyId: 'unexpected' } },
    }));
    registerAutomationReplyHandoffRpcHandler(registrar, {
      machineId: 'machine-1',
      resolveAccountId: async () => 'account-1',
      resolveInstallationId: () => 'installation-1',
      resolveAccountEncryptionCurrentness: async () => plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
      resolveCurrentTargetMaterializationId: async () => currentMaterializationId,
      acquireRuntimeLease: async () => {
        currentMaterializationId = 'materialization-2';
        return createRuntimeLease();
      },
      executeContributedAction,
    });
    const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error('expected Automation reply-handoff RPC handler');

    await expect(handler(request)).resolves.toEqual({
      kind: 'unavailable',
      code: 'targetMismatch',
    });
    expect(executeContributedAction).not.toHaveBeenCalled();
  });

  it('rejects a malformed target ref and cancellation before a plugin invocation', async () => {
    const { handler, executeContributedAction } = createRegistration();
    const controller = new AbortController();
    controller.abort();

    await expect(handler({
      ...request,
      target: {
        ...request.target,
        actionRef: { pluginId: 'Not A Plugin Id', localId: 'caller-selected-action' },
      },
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'invalidRequest',
    });
    await expect(handler(request, { signal: controller.signal })).resolves.toEqual({
      kind: 'unavailable',
      code: 'cancelled',
    });
    expect(executeContributedAction).not.toHaveBeenCalled();
  });

  it('never substitutes another plugin for a frozen third-party delivery target', async () => {
    const { handler, executeContributedAction } = createRegistration();

    await expect(handler({
      ...request,
      target: {
        ...request.target,
        actionRef: { pluginId: 'happier.channels', localId: 'automation/result-deliver-v1' },
      },
    })).resolves.toEqual({
      kind: 'unavailable',
      code: 'targetMismatch',
    });
    expect(executeContributedAction).not.toHaveBeenCalled();
  });

  it('reports a typed unavailable when the frozen target declares no such Action', async () => {
    const { handler, executeContributedAction } = createRegistration({
      execution: { matched: false },
    });

    await expect(handler(request)).resolves.toEqual({
      kind: 'unavailable',
      code: 'actionUnavailable',
    });
    expect(executeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'acme.slack-bridge/automation/reply-deliver-v1',
    }));
  });

  it('blocks legacy, tampered, mode-mismatched, and cross-run content before a plugin effect', async () => {
    const encryptedSnapshot = e2eeSnapshot(7);
    const encryptedCurrentness = e2eeCurrentness(encryptedSnapshot, 8);
    const encryptedRequest = createEncryptedRequest(encryptedSnapshot);
    if (encryptedRequest.handoff.resultEnvelope.t !== 'encrypted') {
      throw new Error('expected encrypted result envelope');
    }
    const tamperedRequest = {
      ...encryptedRequest,
      handoff: {
        ...encryptedRequest.handoff,
        resultEnvelope: {
          ...encryptedRequest.handoff.resultEnvelope,
          c: `${encryptedRequest.handoff.resultEnvelope.c.slice(0, -1)}${encryptedRequest.handoff.resultEnvelope.c.endsWith('A') ? 'B' : 'A'}`,
        },
      },
    };
    const cases = [
      {
        name: 'legacy result',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            resultEnvelope: { t: 'legacySummaryCiphertext', c: 'historical' },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
      {
        name: 'plain under E2EE',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            accountCurrentness: {
              mode: 'e2ee',
              version: encryptedCurrentness.version,
              contentKeyFingerprint: encryptedCurrentness.contentKeyFingerprint,
            },
          },
        },
        currentnessSequence: [encryptedCurrentness],
        materialSequence: [encryptedSnapshot],
      },
      {
        name: 'tampered ciphertext',
        request: tamperedRequest,
        currentnessSequence: [encryptedCurrentness],
        materialSequence: [encryptedSnapshot],
      },
      {
        name: 'cross-account payload',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            resultEnvelope: {
              ...request.handoff.resultEnvelope,
              v: {
                ...request.handoff.resultEnvelope.v,
                correspondence: { ...correspondence, accountId: 'other-account' },
              },
            },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
      {
        name: 'cross-run payload',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            resultEnvelope: {
              ...request.handoff.resultEnvelope,
              v: {
                ...request.handoff.resultEnvelope.v,
                correspondence: { ...correspondence, runId: 'other-run' },
              },
            },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
      {
        name: 'Run-only result correspondence',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            resultEnvelope: {
              ...request.handoff.resultEnvelope,
              v: {
                ...request.handoff.resultEnvelope.v,
                correspondence: {
                  accountId: correspondence.accountId,
                  automationId: correspondence.automationId,
                  runId: correspondence.runId,
                },
              },
            },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
      {
        name: 'cross-automation reply context',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            replyContextEnvelope: {
              ...request.handoff.replyContextEnvelope,
              v: {
                ...request.handoff.replyContextEnvelope.v,
                correspondence: {
                  ...replyContextCorrespondence,
                  automationId: 'other-automation',
                },
              },
            },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
      {
        name: 'wrong occurrence reply context',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            replyContextEnvelope: {
              ...request.handoff.replyContextEnvelope,
              v: {
                ...request.handoff.replyContextEnvelope.v,
                correspondence: {
                  ...replyContextCorrespondence,
                  occurrenceKey: 'B'.repeat(43),
                },
              },
            },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
      {
        name: 'legacy finalized reply context',
        request: {
          ...request,
          handoff: {
            ...request.handoff,
            replyContextEnvelope: {
              ...request.handoff.replyContextEnvelope,
              v: {
                ...request.handoff.replyContextEnvelope.v,
                correspondence,
                source,
              },
            },
          },
        },
        currentnessSequence: [plainCurrentness],
        materialSequence: [null],
      },
    ] as const;

    for (const testCase of cases) {
      const { handler, executeContributedAction } = createRegistration({
        currentnessSequence: testCase.currentnessSequence,
        materialSequence: testCase.materialSequence,
      });
      await expect(handler(testCase.request)).resolves.toEqual({
        kind: 'settled',
        settlement: { kind: 'blocked' },
        accountCurrentness: {
          mode: testCase.currentnessSequence[0]!.mode,
          version: testCase.currentnessSequence[0]!.version,
          contentKeyFingerprint: testCase.currentnessSequence[0]!.contentKeyFingerprint,
        },
      });
      expect(executeContributedAction, testCase.name).not.toHaveBeenCalled();
    }
  });

  it('returns staleClaim before opening when claim-time Account authority has moved', async () => {
    const newerCurrentness: AccountEncryptionCurrentnessResponse = {
      ...plainCurrentness,
      version: plainCurrentness.version + 1,
      updatedAt: plainCurrentness.updatedAt + 1,
    };
    const { handler, executeContributedAction } = createRegistration({
      currentnessSequence: [newerCurrentness],
    });

    await expect(handler(request)).resolves.toEqual({
      kind: 'settled',
      settlement: { kind: 'staleClaim' },
      accountCurrentness: {
        mode: 'plain',
        version: newerCurrentness.version,
        contentKeyFingerprint: null,
      },
    });
    expect(executeContributedAction).not.toHaveBeenCalled();
  });

  it('reports a stale claim for missing or rekeyed E2EE material before a plugin effect or receipt', async () => {
    const sealedWithOldKey = e2eeSnapshot(7);
    const currentKey = e2eeSnapshot(9);
    const encryptedRequest = createEncryptedRequest(sealedWithOldKey);
    const currentness = e2eeCurrentness(currentKey, 8);

    for (const materialSequence of [[null], [sealedWithOldKey]] as const) {
      const { handler, executeContributedAction } = createRegistration({
        currentnessSequence: [currentness],
        materialSequence,
      });
      await expect(handler(encryptedRequest)).resolves.toEqual({
        kind: 'settled',
        settlement: { kind: 'staleClaim' },
        accountCurrentness: {
          mode: 'e2ee',
          version: 8,
          contentKeyFingerprint: currentness.contentKeyFingerprint,
        },
      });
      expect(executeContributedAction).not.toHaveBeenCalled();
    }
  });

  it('treats plain Account mode as keyless even if stale local E2EE material remains', async () => {
    const { handler, executeContributedAction, resolveAccountEncryptionMaterial } = createRegistration({
      currentnessSequence: [plainCurrentness],
      materialSequence: [e2eeSnapshot(7)],
    });

    await expect(handler(request)).resolves.toMatchObject({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
    });
    expect(executeContributedAction).toHaveBeenCalledOnce();
    expect(resolveAccountEncryptionMaterial).not.toHaveBeenCalled();
  });

  it('seals an E2EE receipt in its receipt-only domain before returning coarse settlement', async () => {
    const snapshot = e2eeSnapshot(7);
    const currentness = e2eeCurrentness(snapshot, 8);
    const { handler, executeContributedAction } = createRegistration({
      currentnessSequence: [currentness, currentness, currentness],
      materialSequence: [snapshot, snapshot, snapshot],
    });

    const response = AutomationReplyHandoffDispatchResultV1Schema.parse(
      await handler(createEncryptedRequest(snapshot)),
    );
    expect(response).toMatchObject({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: currentness.contentKeyFingerprint,
      },
      receiptEnvelope: { t: 'encrypted' },
    });
    if (response.kind !== 'settled' || !response.receiptEnvelope) {
      throw new Error('expected settled encrypted receipt');
    }
    expect(openAutomationReplyHandoffReceiptStoredEnvelopeV1({
      mode: 'e2ee',
      material: snapshot.material,
      envelope: response.receiptEnvelope,
    })).toEqual({
      kind: 'available',
      correspondence,
      result: { kind: 'accepted', custodyId: 'custody-1' },
    });
    expect(executeContributedAction).toHaveBeenCalledOnce();
  });

  it('returns retry without a receipt if Account currentness changes after the Action effect', async () => {
    const oldSnapshot = e2eeSnapshot(7);
    const newSnapshot = e2eeSnapshot(9);
    const oldCurrentness = e2eeCurrentness(oldSnapshot, 8);
    const newCurrentness = e2eeCurrentness(newSnapshot, 9);
    const { handler, executeContributedAction } = createRegistration({
      currentnessSequence: [oldCurrentness, oldCurrentness, newCurrentness],
      materialSequence: [oldSnapshot, oldSnapshot, newSnapshot],
    });

    await expect(handler(createEncryptedRequest(oldSnapshot))).resolves.toEqual({
      kind: 'settled',
      settlement: { kind: 'retry', retryAfterMs: 0 },
      accountCurrentness: {
        mode: 'e2ee',
        version: 9,
        contentKeyFingerprint: newCurrentness.contentKeyFingerprint,
      },
    });
    expect(executeContributedAction).toHaveBeenCalledOnce();
  });

  it('preserves an accepted A custody result when B publishes during the Action', async () => {
    const { handlers, registrar } = createRegistrar();
    let currentMaterializationId = 'materialization-1';
    const executeContributedAction = vi.fn<AutomationReplyHandoffActionExecutor>(async () => {
      currentMaterializationId = 'materialization-2';
      return {
        matched: true,
        result: { ok: true, result: { kind: 'accepted', custodyId: 'custody-a' } },
      };
    });
    registerAutomationReplyHandoffRpcHandler(registrar, {
      machineId: 'machine-1',
      resolveAccountId: async () => 'account-1',
      resolveInstallationId: () => 'installation-1',
      resolveAccountEncryptionCurrentness: async () => plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
      resolveCurrentTargetMaterializationId: async () => currentMaterializationId,
      acquireRuntimeLease: async () => createRuntimeLease(),
      executeContributedAction,
    });
    const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error('expected Automation reply-handoff RPC handler');

    await expect(handler(request)).resolves.toEqual({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
      receiptEnvelope: {
        t: 'plain',
        v: {
          v: 1,
          correspondence,
          result: { kind: 'accepted', custodyId: 'custody-a' },
        },
      },
    });
    expect(executeContributedAction).toHaveBeenCalledOnce();
  });

  it('returns unavailable rather than fabricating a reply when the current target Action is absent', async () => {
    const { handler, executeContributedAction, release } = createRegistration({
      execution: { matched: false },
    });

    await expect(handler(request)).resolves.toEqual({
      kind: 'unavailable',
      code: 'actionUnavailable',
    });
    expect(executeContributedAction).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    });
  });

  it('settles a retired Channels custody replay without requesting another handoff attempt', async () => {
    const { handler } = createRegistration({
      execution: {
        matched: true,
        result: { ok: true, result: { kind: 'retired' } },
      },
    });

    await expect(handler(request)).resolves.toEqual({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
      receiptEnvelope: {
        t: 'plain',
        v: {
          v: 1,
          correspondence,
          result: { kind: 'retired' },
        },
      },
    });
  });
