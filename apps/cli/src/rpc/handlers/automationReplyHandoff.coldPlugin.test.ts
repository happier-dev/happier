import { expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { AutomationResultDeliveryInputV1JsonSchema, AutomationResultDeliveryResultV1JsonSchema } from '@happier-dev/plugin-sdk/automations';
import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1, AutomationOccurrenceKeyV1Schema } from '@happier-dev/protocol';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { registerAutomationReplyHandoffRpcHandler } from './automationReplyHandoff';

it('delivers a frozen result to an admitted cold plugin through its real Action', async () => {
  const pluginId = 'example.cold-delivery';
  const localId = 'reply';
  const machineId = 'machine-1';
  const received: unknown[] = [];
  const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    actions: { reply: { title: 'Deliver result', execution: { target: 'daemon' }, scopes: ['machine'],
      surfaces: ['plugin'], dangerLevel: 'safe', readOnly: false,
      inputSchema: AutomationResultDeliveryInputV1JsonSchema, resultSchema: AutomationResultDeliveryResultV1JsonSchema,
      run: input => { received.push(input); return { kind: 'accepted' as const, custodyId: 'custody-1' }; } } },
  });
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
    plugins: [{ manifest: plugin.manifest, includeAvailability: true,
      files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
    runtimeOptions: { resolveCurrentMachineId: () => machineId },
  });
  try {
    expect(fixture.registry.activatedPluginIds.has(pluginId)).toBe(false);
    const materializationId = fixture.registry.contributes.materializationIdsByPluginId?.[pluginId];
    expect(materializationId).toBeTruthy();
    const accountId = 'account-1';
    const correspondence = { accountId, automationId: 'automation-1', runId: 'run-1', handoffId: 'handoff-1' };
    const occurrenceKey = AutomationOccurrenceKeyV1Schema.parse('A'.repeat(43));
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain', version: 7, updatedAt: 1 });
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerAutomationReplyHandoffRpcHandler(registrar, {
      machineId, resolveAccountId: async () => accountId, resolveInstallationId: () => 'installation-1',
      resolveAccountEncryptionCurrentness: async () => currentness, resolveAccountEncryptionMaterial: async () => null,
      workflowRunStorage: { execute: async () => { throw new Error('Unexpected Workflow storage read'); } },
      acquireRuntimeLease: () => fixture.controller.acquireRuntimeRegistry(),
    });
    const handler = handlers.get(AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1);
    if (!handler) throw new Error('Missing reply handoff handler');
    const request = { v: 1, kind: 'automation.replyHandoff.dispatch',
      target: { accountId, machineId, machineInstallationId: 'installation-1', materializationId,
        actionRef: { pluginId, localId } },
      handoff: { handoffId: correspondence.handoffId, runId: correspondence.runId, automationId: correspondence.automationId,
        occurrenceKey, cause: { kind: 'conversation', occurrenceKey, occurredAt: 1 },
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
        resultEnvelope: { t: 'plain', v: { v: 1, correspondence, result: { v: 1, kind: 'text', text: 'Completed.' } } },
        replyContextEnvelope: { t: 'plain', v: { v: 1, correspondence: { automationId: correspondence.automationId, occurrenceKey },
          opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' } } } },
    };
    await expect(handler(request)).resolves.toEqual({ kind: 'settled', settlement: { kind: 'accepted' },
      accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null } });
    expect(received).toHaveLength(1);
    await expect(handler({ ...request, target: { ...request.target, materializationId: 'different-materialization' } }))
      .resolves.toEqual({ kind: 'unavailable', code: 'targetMismatch' });
    expect(received).toHaveLength(1);
  } finally { await fixture.dispose(); }
});
