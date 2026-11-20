import { afterEach, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { registerExecutionRunHandlers } from '../../rpc/handlers/executionRuns';
import { createMutableApiSessionClientFixture } from '../../testkit/backends/sessionFixtures';
import { ProviderEnforcedPermissionHandler } from '../../agent/permissions/providerEnforced/handler';
import type { ExecutionRunAppliedParentSelection } from '../../agent/runtime/bridges/executionRun/runtime/openInputs';
import { SessionAgentStartSelectionResponseV1Schema } from './agentStartSelectionRpc';

afterEach(() => vi.restoreAllMocks());

it('publishes the live Session applied selection after its proposal turn completes without manufacturing authority', async () => {
  const sessionId = 'selection-owner';
  let turnId: string | null = 'selection-turn';
  const session = createMutableApiSessionClientFixture({ sessionId });
  const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
  const selection = { status: 'applied' as const, backendTarget: { kind: 'backend' as const, backendId: 'acme.agent/worker' },
    modelId: 'selected-model', connectedServices: null };
  let readSelection: () => Promise<ExecutionRunAppliedParentSelection> = async () => selection;
  let nativeReads = 0;
  const registration = registerExecutionRunHandlers(rpc, { sessionId, cwd: '/workspace', parentProvider: 'codex',
    sendAcp: async () => {}, sessionInteractionHost: { session, machineId: 'machine',
      permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: 'selection-test' }),
      readCurrentTurnId: () => turnId,
      readAppliedChildSelection: () => { nativeReads++; return readSelection(); },
    } });
  const read = (requestedTurnId: string) => rpc.invokeLocal('session.agentStart.selection.read.v1', { turnId: requestedTurnId });
  try {
    await expect(read('selection-turn')).resolves.toEqual({ sessionId, turnId: 'selection-turn', selection });
    expect(nativeReads).toBe(1);
    await expect(read('foreign-turn')).resolves.toMatchObject({ selection });
    turnId = null;
    await expect(read('selection-turn')).resolves.toMatchObject({ selection });
    expect(nativeReads).toBe(3);
    turnId = 'selection-turn';
    for (const backendTarget of [
      { ...selection.backendTarget, unexpected: true },
      { ...selection.backendTarget, sourceKind: 'configured' as const },
      { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'worker', unexpected: true } },
    ]) {
      readSelection = async () => ({ ...selection, backendTarget });
      const malformed = await readSelection();
      expect(SessionAgentStartSelectionResponseV1Schema.safeParse({ sessionId, turnId, selection: malformed }).success, 'private envelope').toBe(false);
      await expect(read('selection-turn')).resolves.toMatchObject({ selection: { status: 'unavailable' } });
    }
    expect(nativeReads).toBe(6);
    const teamSelection = {
      ...selection,
      backendTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'worker' } },
      teamCredentialModel: { kind: 'team_credential_provider_model' as const, resourceId: 'resource', teamId: 'team',
        expectedResourceRevision: 1, agentTargetKey: 'agent:acme.agent/worker', modelId: 'selected-model',
        deliveryMode: 'vendor-native' as const, nativeDelivery: { managedId: 'managed', controllerInstallationId: 'controller',
          guestInstallationId: 'guest', bindingKey: 'binding', placeholderRef: 'placeholder', sourceRevision: 'revision',
          providerTicket: 'a'.repeat(43) } },
      connectedServices: { v: 2 as const, bindingsByServiceId: { 'acme.service/account': { source: 'team_resource' as const,
        resourceId: 'connected-resource', deliveryMode: 'direct' as const,
        disclosedMember: { service: { pluginId: 'acme.service', localId: 'account' }, accountId: 'account' } } } },
    } satisfies ExecutionRunAppliedParentSelection;
    readSelection = async () => teamSelection;
    await expect(read('selection-turn')).resolves.toEqual({ sessionId, turnId: 'selection-turn', selection: teamSelection });
    expect(nativeReads).toBe(7);
    readSelection = async () => ({ status: 'unavailable', reason: 'direct_custody' });
    await expect(read('selection-turn')).resolves.toEqual({
      sessionId, turnId: 'selection-turn', selection: { status: 'unavailable', reason: 'direct_custody' },
    });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    readSelection = async () => { entered(); await held; return selection; };
    const pending = read('selection-turn');
    await reading;
    turnId = 'successor-turn';
    release();
    await expect(pending).resolves.toMatchObject({ selection });
    expect(nativeReads).toBe(9);
    registration.dispose();
    turnId = 'selection-turn';
    await expect(read('selection-turn')).resolves.toMatchObject({ selection: { status: 'unavailable' } });
    expect(nativeReads).toBe(9);
  } finally { registration.dispose(); }
});
