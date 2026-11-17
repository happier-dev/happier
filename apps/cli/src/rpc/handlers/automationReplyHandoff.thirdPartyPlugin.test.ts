import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
  AutomationConversationActionHttpPathsV1,
  AutomationConversationActionHttpRequestSchemasV1,
  AutomationOccurrenceKeyV1Schema,
  AutomationReplyHandoffDispatchRequestV1Schema,
  AutomationReplyHandoffTargetV1Schema,
  AutomationResultDeliveryInputV1Schema,
  isAutomationConversationResultDeliveryOwnedByCallerV1,
  sealAutomationConversationReplyContextStoredEnvelopeV1,
  sealAutomationRunResultStoredEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  prepareWorkflowRunDataKeyV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  type AccountEncryptionCurrentnessResponse,
  type WorkflowRunRecipientCensusResponseV1,
} from '@happier-dev/protocol';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

import { registerAutomationReplyHandoffRpcHandler } from './automationReplyHandoff';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';

const transportMocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
}));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: transportMocks.post } };
});
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: transportMocks.createPublisherHeader,
}));

// eslint-disable-next-line import/first -- the axios/publisher boundaries are mocked above.
import { createAutomationConversationActionExecutor } from '@/plugins/runtime/automations/automationConversationActionExecutor';

/**
 * A synthetic out-of-tree bridge that is not a Channel plugin. It exercises the
 * whole Conversation Automation participation: it admits an occurrence naming
 * its OWN reply-delivery Action contribution, and the daemon delivers the Run
 * result back into that contribution.
 */
const BRIDGE_PLUGIN_ID = 'acme.slack-bridge';
const BRIDGE_REPLY_DELIVERY_LOCAL_ID = 'automation/reply-deliver-v1';
const BRIDGE_INGRESS_LOCAL_ID = 'slack/observation-ingest-v1';

const accountId = 'account-1';
const machineId = 'machine-1';
const machineInstallationId = 'installation-1';
const materializationId = 'materialization-slack-1';
const runtimeOccurrenceId = 'occurrence-slack-1';
const sourceCustody = {
  kind: 'managed',
  immutableGenerationId: 'generation-slack-1',
  installSource: 'archive',
} as const;

const correspondence = {
  accountId,
  automationId: 'automation-1',
  runId: 'run-1',
  handoffId: 'automation-reply-handoff:run-1',
} as const;

const replyContextCorrespondence = {
  automationId: correspondence.automationId,
  occurrenceKey: AutomationOccurrenceKeyV1Schema.parse('A'.repeat(43)),
} as const;

const opaqueContext = {
  v: 1,
  kind: 'slackConversationReply',
  channelId: 'C-123',
  messageTs: '1700000000.000100',
} as const;

const result = { v: 1, kind: 'text', text: 'Summarized the latest change.' } as const;

const plainCurrentness: AccountEncryptionCurrentnessResponse = createAccountEncryptionCurrentnessFixture({
  mode: 'plain',
  version: 7,
  updatedAt: 1,
});

const admitInput = {
  automationId: correspondence.automationId,
  bindingId: 'binding-1',
  occurrenceId: 'slack:event:1',
  occurredAt: 1_700_000_000_000,
  sender: { id: 'U-123' },
  text: 'Please summarize the latest change.',
  resultDelivery: {
    kind: 'finalResult',
    actionRef: { pluginId: BRIDGE_PLUGIN_ID, localId: BRIDGE_REPLY_DELIVERY_LOCAL_ID },
    opaqueContext,
  },
} as const;

function createBridgeRuntimeRegistry(
  invoke: (call: Readonly<{ pluginId: string; localId: string; input: unknown }>) => unknown,
): ResolvedExecutablePluginRuntimeRegistry {
  const action = {
    pluginId: BRIDGE_PLUGIN_ID,
    definition: {
      id: BRIDGE_REPLY_DELIVERY_LOCAL_ID,
      surfaces: { plugin: true },
      execution: { target: 'daemon' },
    },
  } as unknown as ResolvedActionContribution;
  return {
    contributes: {
      actionsById: new Map([
        [`${BRIDGE_PLUGIN_ID}/${BRIDGE_REPLY_DELIVERY_LOCAL_ID}`, action],
      ]),
    },
    targetActionInvocations: {
      expects: (pluginId: string, localId: string) => (
        pluginId === BRIDGE_PLUGIN_ID && localId === BRIDGE_REPLY_DELIVERY_LOCAL_ID
      ),
      has: (pluginId: string, localId: string) => (
        pluginId === BRIDGE_PLUGIN_ID && localId === BRIDGE_REPLY_DELIVERY_LOCAL_ID
      ),
      invoke: async (call: Readonly<{ pluginId: string; localId: string; input: unknown }>) => ({
        status: 'executed' as const,
        value: invoke(call),
      }),
    },
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

function createRegistrar(): Readonly<{
  handlers: Map<string, RpcHandler>;
  registrar: RpcHandlerRegistrar;
}> {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
  };
}

describe('Conversation Automation participation for a non-Channels plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers a Workflow result through its fresh owner Run-key census instead of the Account content key', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'e2ee', version: 8, updatedAt: 8,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) });
    const witness = { mode: 'e2ee' as const, version: currentness.version, contentKeyFingerprint: currentness.contentKeyFingerprint! };
    const randomBytes = (length: number) => new Uint8Array(length).fill(19);
    const prepared = prepareWorkflowRunDataKeyV1({ accountId, encryption: { kind: 'available', witness, material }, randomBytes });
    const runCrypto = prepared.runCrypto;
    if (runCrypto.mode !== 'e2ee') throw new Error('E2EE fixture requires an encrypted Run data key');
    const ownerKey = prepared.recipientKeyEnvelopes[0].encryptedDataKey;
    const keyCensus = { runId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'e2ee',
      visibleTeamId: null, ownerAccountCurrentness: witness, dataEncryptionKey: ownerKey, callerDataEncryptionKey: ownerKey,
      recipients: [] } satisfies WorkflowRunRecipientCensusResponseV1;
    transportMocks.post.mockResolvedValue({ data: keyCensus });
    const dispatch = AutomationReplyHandoffDispatchRequestV1Schema.parse({ v: 1, kind: 'automation.replyHandoff.dispatch',
      target: { accountId, machineId, machineInstallationId, materializationId,
        actionRef: { pluginId: BRIDGE_PLUGIN_ID, localId: BRIDGE_REPLY_DELIVERY_LOCAL_ID } },
      handoff: { handoffId: `automation-reply-handoff:${runId}`, runId, automationId: correspondence.automationId,
        occurrenceKey: replyContextCorrespondence.occurrenceKey, cause: { kind: 'conversation', occurredAt: 1,
          occurrenceKey: replyContextCorrespondence.occurrenceKey }, accountCurrentness: witness, recipeKind: 'workflow-v2',
        resultEnvelope: sealWorkflowFinalResultStoredEnvelopeV1({ ...runCrypto, randomBytes,
          binding: { v: 1, purpose: 'final_result', accountId, runId },
          finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: result.text },
            producerInvocation: { recordId: '22222222-2222-4222-8222-222222222222' } } }),
        replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({ mode: 'e2ee', material: material.material,
          randomBytes, correspondence: replyContextCorrespondence, opaqueContext }),
      },
    });
    const delivered: unknown[] = [];
    // This is the third-party plugin boundary; the real contributed Action dispatcher runs below it.
    const registry = createBridgeRuntimeRegistry(call => { delivered.push(call.input); return { kind: 'accepted', custodyId: 'custody' }; });
    const { handlers, registrar } = createRegistrar();
    const options = { machineId, resolveAccountId: async () => accountId, resolveInstallationId: () => machineInstallationId,
      resolveAccountEncryptionCurrentness: async () => currentness, resolveAccountEncryptionMaterial: async () => material,
      resolveCurrentTargetMaterializationId: async () => materializationId,
      acquireRuntimeLease: async () => ({ registry, source: 'active' as const, durableRevision: -1, release: async () => {} }),
      workflowRunStorage: createWorkflowRunStorageClient({ token: 'test-token', serverHttpBaseUrl: 'https://example.test' }),
      executeContributedAction };
    registerAutomationReplyHandoffRpcHandler(registrar, options);
    const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error('Missing reply handler');
    await expect(handler(dispatch)).resolves.toEqual({ kind: 'settled', settlement: { kind: 'accepted' }, accountCurrentness: witness });
    expect(delivered).toEqual([expect.objectContaining({ result, opaqueContext })]);

    // Rejoin must fetch the current envelope, never reuse the key from an earlier delivery.
    transportMocks.post.mockResolvedValueOnce({ data: { ...keyCensus, callerDataEncryptionKey: null } });
    await expect(handler(dispatch)).resolves.toEqual({ kind: 'settled', settlement: { kind: 'blocked' }, accountCurrentness: witness });
    for (const changedIdentity of [
      { runId: '33333333-3333-4333-8333-333333333333' },
      { ownerAccountId: 'another-account' },
    ]) {
      transportMocks.post.mockResolvedValueOnce({ data: { ...keyCensus, ...changedIdentity } });
      await expect(handler(dispatch)).resolves.toEqual({ kind: 'unavailable', code: 'targetMismatch' });
    }
    transportMocks.post.mockResolvedValueOnce({ data: { ...keyCensus,
      ownerAccountCurrentness: { ...witness, version: witness.version + 1 } } });
    await expect(handler(dispatch)).resolves.toEqual({ kind: 'settled', settlement: { kind: 'accepted' }, accountCurrentness: witness });
    expect(delivered).toEqual([
      expect.objectContaining({ result, opaqueContext }),
      expect.objectContaining({ result, opaqueContext }),
    ]);
    const alternateMaterial = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(8) } });
    transportMocks.post.mockResolvedValueOnce({ data: { ...keyCensus,
      ownerAccountCurrentness: { ...witness, contentKeyFingerprint:
        convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(alternateMaterial.contentPublicKeyFingerprint) } } });
    await expect(handler(dispatch)).resolves.toEqual({ kind: 'settled', settlement: { kind: 'retry', retryAfterMs: 0 }, accountCurrentness: witness });
    expect(delivered).toEqual([
      expect.objectContaining({ result, opaqueContext }),
      expect.objectContaining({ result, opaqueContext }),
    ]);
  });

  it('binds an existing Account Automation, admits into it, and receives the delivered result', async () => {
    const execute = createAutomationConversationActionExecutor({
      credentials: {
        token: 'token_test',
        encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
      },
      // The admitting host resolves the Account mode before it produces a body.
      resolveAccountId: async () => accountId,
      resolveAccountEncryptionCurrentness: async () => createAccountEncryptionCurrentnessFixture({
        mode: 'plain',
        version: 7,
        updatedAt: 1_700_000_000_000,
      }),
      resolveAccountEncryptionMaterial: async () => null,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
    });

    // 0. The bridge selects the Account Automation the user bound it to. Any
    //    existing Automation is listable here; the bridge authors none.
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: {
        items: [{
          automationId: correspondence.automationId,
          label: 'Daily digest',
          execution: { targetType: 'existing_session', enabled: true },
        }],
        nextCursor: null,
      },
    });
    await expect(execute({
      actionId: 'automation.conversation.targets.list',
      input: {},
      caller: {
        kind: 'plugin',
        pluginId: BRIDGE_PLUGIN_ID,
        contributionLocalId: BRIDGE_INGRESS_LOCAL_ID,
        occurrenceId: runtimeOccurrenceId,
        sourceCustody,
        materialization: { pluginId: BRIDGE_PLUGIN_ID, machineId, materializationId },
      },
    })).resolves.toEqual({
      items: [{
        automationId: correspondence.automationId,
        label: 'Daily digest',
        execution: { targetType: 'existing_session', enabled: true },
      }],
      nextCursor: null,
    });
    const [listPath, listBody] = transportMocks.post.mock.calls[0]! as [string, unknown];
    expect(listPath).toContain(
      AutomationConversationActionHttpPathsV1['automation.conversation.targets.list'],
    );
    const listRequest = AutomationConversationActionHttpRequestSchemasV1[
      'automation.conversation.targets.list'
    ].parse(listBody);
    expect(listRequest.caller.pluginId).toBe(BRIDGE_PLUGIN_ID);
    expect(listRequest.caller.occurrenceId).toBe(runtimeOccurrenceId);
    expect(listRequest.caller.sourceCustody).toEqual(sourceCustody);
    // The payload carries no owner or machine: the host stamps both.
    expect(listRequest.caller.materialization.machineId).toBe(machineId);

    // 1. The bridge admits through the canonical host Action. The host stamps
    //    the caller frame; the real wire contract accepts the bridge naming its
    //    own reply-delivery contribution.
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: { kind: 'admitted', runId: correspondence.runId, checkpointSafe: true },
    });
    const admit = execute;

    await expect(admit({
      actionId: 'automation.conversation.admit',
      input: admitInput,
      caller: {
        kind: 'plugin',
        pluginId: BRIDGE_PLUGIN_ID,
        contributionLocalId: BRIDGE_INGRESS_LOCAL_ID,
        occurrenceId: runtimeOccurrenceId,
        sourceCustody,
        materialization: { pluginId: BRIDGE_PLUGIN_ID, machineId, materializationId },
      },
    })).resolves.toEqual({ kind: 'admitted', runId: correspondence.runId, checkpointSafe: true });

    const [, body] = transportMocks.post.mock.calls[1]! as [string, unknown];
    expect(transportMocks.post.mock.calls[1]![0]).toContain(
      AutomationConversationActionHttpPathsV1['automation.conversation.admit'],
    );
    const admitRequest = AutomationConversationActionHttpRequestSchemasV1[
      'automation.conversation.admit'
    ].parse(body);
    // A plain Account keeps its semantic Action input on the wire.
    if (!('input' in admitRequest)) throw new Error('Expected the plain admission arm');
    expect(admitRequest.input.resultDelivery).toEqual(admitInput.resultDelivery);
    expect(isAutomationConversationResultDeliveryOwnedByCallerV1({
      callerPluginId: admitRequest.caller.pluginId,
      resultDelivery: admitRequest.input.resultDelivery,
    })).toBe(true);

    // 2. The server freezes the caller-stamped machine/installation/
    //    materialization next to the bridge's own delivery contribution.
    const source = {
      kind: 'automationResult',
      automationRunId: correspondence.runId,
      resultId: correspondence.handoffId,
      automationId: correspondence.automationId,
      resultDelivery: 'finalResult',
    } as const;
    const target = AutomationReplyHandoffTargetV1Schema.parse({
      accountId,
      machineId,
      machineInstallationId,
      materializationId,
      actionRef: admitRequest.input.resultDelivery.kind === 'finalResult'
        ? admitRequest.input.resultDelivery.actionRef
        : null,
    });
    const dispatch = AutomationReplyHandoffDispatchRequestV1Schema.parse({
      v: 1,
      kind: 'automation.replyHandoff.dispatch',
      target,
      handoff: {
        handoffId: correspondence.handoffId,
        runId: correspondence.runId,
        automationId: correspondence.automationId,
        occurrenceKey: replyContextCorrespondence.occurrenceKey,
        cause: {
          kind: 'conversation',
          occurrenceKey: replyContextCorrespondence.occurrenceKey,
          occurredAt: 1,
        },
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
        resultEnvelope: sealAutomationRunResultStoredEnvelopeV1({
          mode: 'plain',
          correspondence,
          result,
        }),
        replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
          mode: 'plain',
          correspondence: replyContextCorrespondence,
          opaqueContext,
        }),
      },
    });

    // 3. The daemon delivers into the bridge's declared Action contribution.
    const delivered: unknown[] = [];
    const registry = createBridgeRuntimeRegistry((call) => {
      delivered.push(call.input);
      return { kind: 'accepted', custodyId: 'slack-custody-1' };
    });
    const { handlers, registrar } = createRegistrar();
    registerAutomationReplyHandoffRpcHandler(registrar, {
      machineId,
      workflowRunStorage: { execute: async () => { throw new Error('Ordinary Automation handoffs must not read Workflow storage'); } },
      resolveAccountId: async () => accountId,
      resolveInstallationId: () => machineInstallationId,
      resolveAccountEncryptionCurrentness: async () => plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
      resolveCurrentTargetMaterializationId: async (pluginId) => (
        pluginId === BRIDGE_PLUGIN_ID ? materializationId : null
      ),
      acquireRuntimeLease: async () => ({
        registry,
        source: 'active',
        durableRevision: -1,
        release: async () => {},
      }),
      executeContributedAction,
    });
    const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error('expected Automation reply-handoff RPC handler');

    const response = await handler(dispatch);
    expect(response).toEqual({
      kind: 'settled',
      settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
    });
    expect(response).not.toHaveProperty('receiptEnvelope');
    expect(delivered).toEqual([AutomationResultDeliveryInputV1Schema.parse({
      v: 1,
      handoffId: correspondence.handoffId,
      runId: correspondence.runId,
      automationId: correspondence.automationId,
      source,
      result,
      opaqueContext,
    })]);
  });

  it('reports a typed unavailable when the frozen third-party target is not installed', async () => {
    const registry = createBridgeRuntimeRegistry(() => {
      throw new Error('the uninstalled target must never be invoked');
    });
    const { handlers, registrar } = createRegistrar();
    registerAutomationReplyHandoffRpcHandler(registrar, {
      machineId,
      workflowRunStorage: { execute: async () => { throw new Error('Ordinary Automation handoffs must not read Workflow storage'); } },
      resolveAccountId: async () => accountId,
      resolveInstallationId: () => machineInstallationId,
      resolveAccountEncryptionCurrentness: async () => plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
      // No current materialization for the frozen plugin: it is uninstalled.
      resolveCurrentTargetMaterializationId: async () => null,
      acquireRuntimeLease: async () => ({
        registry,
        source: 'active',
        durableRevision: -1,
        release: async () => {},
      }),
      executeContributedAction,
    });
    const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error('expected Automation reply-handoff RPC handler');

    const source = {
      kind: 'automationResult',
      automationRunId: correspondence.runId,
      resultId: correspondence.handoffId,
      automationId: correspondence.automationId,
      resultDelivery: 'finalResult',
    } as const;
    const dispatch = AutomationReplyHandoffDispatchRequestV1Schema.parse({
      v: 1,
      kind: 'automation.replyHandoff.dispatch',
      target: {
        accountId,
        machineId,
        machineInstallationId,
        materializationId,
        actionRef: { pluginId: BRIDGE_PLUGIN_ID, localId: BRIDGE_REPLY_DELIVERY_LOCAL_ID },
      },
      handoff: {
        handoffId: correspondence.handoffId,
        runId: correspondence.runId,
        automationId: correspondence.automationId,
        occurrenceKey: replyContextCorrespondence.occurrenceKey,
        cause: {
          kind: 'conversation',
          occurrenceKey: replyContextCorrespondence.occurrenceKey,
          occurredAt: 1,
        },
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
        resultEnvelope: sealAutomationRunResultStoredEnvelopeV1({
          mode: 'plain',
          correspondence,
          result,
        }),
        replyContextEnvelope: sealAutomationConversationReplyContextStoredEnvelopeV1({
          mode: 'plain',
          correspondence: replyContextCorrespondence,
          opaqueContext,
        }),
      },
    });

    await expect(handler(dispatch)).resolves.toEqual({
      kind: 'unavailable',
      code: 'targetMismatch',
    });
  });
});
