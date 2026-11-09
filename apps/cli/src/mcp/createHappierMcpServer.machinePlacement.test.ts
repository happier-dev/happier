import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec, type ActionId } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpServer } from './createHappierMcpServer';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('restricted Session MCP Machine placement', () => {
  it.each([
    ['localServices.inventory.list', { machineId: 'target-machine', projection: 'count' },
      { summary: { v: 1, state: 'ready', runningCount: 0 } }],
    ['localServices.actions.stopManaged', { requestId: 'stop-service', action: 'stop_managed',
      target: { kind: 'managed_service', managedServiceId: 'service', machineId: 'target-machine' } }, null],
    ['localServices.publicPreview.status', { machineId: 'target-machine' }, null],
    ['machines.provisioners.check', { homeId: 'home', controller: { machineId: 'target-machine', installationId: 'installation' },
      contribution: { pluginId: 'happier.provisioner.devcontainer', localId: 'devcontainer' } }, null],
    ['machines.managed.inspect', { homeId: 'home', managedId: 'devcontainer' }, null],
    ['machines.managed.list', { homeId: 'home' }, { machines: [] }],
  ] satisfies ReadonlyArray<readonly [ActionId, unknown, unknown]>)('keeps %s in daemon custody with exact operands and admission lifetime', async (actionId, rawInput, rawResult) => {
    const sessionId = 'machine-placement-session';
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse(rawInput);
    const requests: unknown[] = [];
    const denied = { ok: false as const, errorCode: 'permission_denied', error: 'permission_denied' };
    const outputSchema = spec.outputSchema;
    if (rawResult && !outputSchema) throw new Error('Expected an Action output schema');
    const outcome = rawResult && outputSchema ? { ok: true as const, result: outputSchema.parse(rawResult) } : denied;
    let refuse = false;
    // The remote daemon is a process/network boundary. Its strict request parser,
    // capability file, TCP transport and the entire Session MCP composition stay real.
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId, execute: async operation => {
      requests.push(operation);
      expect(operation).toMatchObject({ kind: 'action.execute', actionId, input, surface: 'agent',
        witness: { turnId: 'machine-turn', inputId: 'machine-input' } });
      return refuse ? denied : outcome;
    } });
    let current = true;
    const lifetime = new AbortController();
    const runtime = createHappierMcpServer({ sessionId,
      getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://machine-placement.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }), updateMetadata() {},
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getRuntimeLifetimeSignal: () => lifetime.signal,
      getActiveTurnAdmissionWitness: () => current ? { turnId: 'machine-turn', inputId: 'machine-input',
        userMessageSeq: 1, userMessageSeqs: [1] } : null,
    }, { authorityScope: 'session', sessionCredentials: { token: 'session-only-fixture', encryption: null },
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }), getAccountSettings: () => null },
    });
    const invoke = () => runtime.executeTool({ toolName: 'action_execute', args: { actionId, input } });
    try {
      expect(await invoke()).toEqual(outcome);
      expect(requests).toHaveLength(1);
      refuse = true;
      expect(await invoke()).toEqual(denied);
      expect(requests).toHaveLength(2);
      current = false;
      expect(await invoke()).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      current = true;
      lifetime.abort();
      expect(await invoke()).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(requests).toHaveLength(2);
    } finally {
      await runtime.mcp.close();
      await daemon.close();
    }
  });
});
