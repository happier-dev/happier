import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createSessionLifecycleRpcActionExecutor, registerSessionLifecycleRpcHandlers, type SessionLifecycleActionHandlers } from '@/rpc/handlers/sessionLifecycle';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it('retains admitted handoff custody through source enrichment and rejects a changed destination on replay', async () => {
  const input = {
    sessionId: 'cmwagqalz008omccdtt4qggcq',
    sourceMachineId: 'eadc2422-b42b-478d-97b1-af9b530d5f08',
    targetMachineId: '5964761d-2877-45f3-89f0-83aa71805967',
    targetSessionStorageMode: 'persisted' as const,
    workspaceAction: { kind: 'none' as const },
    accountServerId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
    actionRequestId: 'QA-ACTION-PARITY-1109-r117-handoff-5964',
  };
  const runtime = createHostActionOperationRuntime({ machineId: input.sourceMachineId, resolveAccountId: async () => 'owner' });
  const rpc = new RpcHandlerManager({ scopePrefix: input.sourceMachineId, encryptionMode: 'plain' });
  // HTTP and the native handoff effect are boundaries. Admission, source
  // resolution, CLI enrichment, local RPC and operation reconciliation are real.
  const native = vi.fn<NonNullable<SessionLifecycleActionHandlers['session.handoff']>>(async () => (
    { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }));
  registerSessionLifecycleRpcHandlers({ rpcHandlerManager: rpc, actionIds: ['session.handoff'],
    actionExecutor: createSessionLifecycleRpcActionExecutor({ 'session.handoff': native }), observeExecution: runtime.observeExecution });
  const session = createCurrentSessionProjectionRecordFixture({ id: input.sessionId, encryptionMode: 'plain', share: null,
    metadata: JSON.stringify({ machineId: input.sourceMachineId, path: '/repo' }),
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {}, capabilities: {
    encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } })));
  vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v2/sessions/')
    ? { status: 200, data: { session } }
    : { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
      updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } });
  const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
    sessionId: input.sessionId, mode: 'plain', ctx: null, serverId: input.accountServerId,
    serverHttpBaseUrl: 'https://handoff.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    machineActionDirectTargetTransport: { machineId: input.sourceMachineId,
      invoke: (method, request, options) => rpc.invokeLocal(method, request, options) },
  }));
  const invoke = (value = input) => executor.execute('session.handoff', value, {
    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    runActionOperation: runtime.runActionOperation,
    defaultSessionId: input.sessionId,
    serverId: input.accountServerId, actionRequestId: '3002f6fd-055e-4d16-9b11-4e2c4c655eb4',
    presentUserConfirmation: { actionId: 'session.handoff' },
  });
  const result = await invoke();
  expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  expect(native).toHaveBeenCalledOnce();
  expect(native.mock.calls[0]?.[0]).toMatchObject({ targetMachineId: input.targetMachineId, sessionStorageMode: 'persisted',
    preferredTransportStrategies: ['direct_peer', 'server_routed_stream'] });
  expect(await invoke()).toEqual(result);
  expect(native).toHaveBeenCalledOnce();
  expect(await invoke({ ...input, targetMachineId: 'ffd72b3e-40ca-4644-9bd2-46753a01d8cb' }))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(native).toHaveBeenCalledOnce();
});
