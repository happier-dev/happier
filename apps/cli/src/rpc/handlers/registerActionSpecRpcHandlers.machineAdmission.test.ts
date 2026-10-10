import { describe, expect, it } from 'vitest';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { registerActionSpecRpcHandlers, unwrapActionResultForRpc } from './registerActionSpecRpcHandlers';

describe('registered finite Action Machine admission', () => {
  it('preserves only the actual retirement dependency and uncertain-outcome facts across the public RPC failure', () => {
    const dependencies = [{ operationId: 'accepted', workspaceRefId: 'copy', state: 'reserved' as const }];
    const refused = { ok: false as const, errorCode: 'workspace_sync_relationship_in_use', error: 'in use',
      details: { dependencies, privatePath: '/must-not-cross' } };
    expect(unwrapActionResultForRpc('projects.worker.copy.retire', refused)).toEqual({ ...refused, details: { dependencies } });
    expect(unwrapActionResultForRpc('projects.worker.copy.retire', { ...refused,
      details: { dependencies: [{ ...dependencies[0], unexpected: true }] } })).not.toHaveProperty('details');
    const uncertain = { ok: false as const, errorCode: 'workspace_copy_removal_unknown', error: 'unknown',
      details: { kind: 'outcomeUnknown', privatePath: '/must-not-cross' } };
    expect(unwrapActionResultForRpc('projects.worker.copy.retire', uncertain)).toEqual({ ...uncertain, details: { kind: 'outcomeUnknown' } });
    const retiredWithDependencies = { ...refused, details: { kind: 'outcomeUnknown', dependencies, privatePath: '/must-not-cross' } };
    expect(unwrapActionResultForRpc('projects.worker.copy.retire', retiredWithDependencies))
      .toEqual({ ...retiredWithDependencies, details: { kind: 'outcomeUnknown', dependencies } });
    expect(unwrapActionResultForRpc('projects.worker.status', refused)).not.toHaveProperty('details');
  });
  it('consumes the actual Home stamp and currentness at the receiving factory before Account or process effects', async () => {
    const signal = new AbortController().signal;
    const noEffect = async (): Promise<never> => { throw new Error('No effect is admitted'); };
    // PTY spawn is the OS boundary; admission, custody and terminal policy are real.
    const terminalSessions = createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig({}).sessionManager,
      env: {}, ptyProvider: { spawn() { throw new Error('No process is admitted'); } } });
    const runtime: ProjectFiniteActionRuntime = {
      serverId: 'home', machineId: 'machine', accountId: 'owner',
      credentials: { token: 'receiver', encryption: null }, serverHttpBaseUrl: 'https://home.invalid',
      operationRuntime: createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'owner' }),
      workerAdmission: createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
        readPolicy: noEffect }),
      resolveWorkspaceExecutionConfig: async () => createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null,
        randomBytes: size => new Uint8Array(size), isCurrent: () => true,
        transport: { read: noEffect, mutate: noEffect } }),
      nativeIo: { resolveTool: noEffect }, environmentIo: { resolveTool: noEffect, run: noEffect },
      terminalSessions,
    };
    const handlers = new Map<string, RpcHandler>();
    registerActionSpecRpcHandlers({
      rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
      targetMachineId: 'machine', actionIds: ['projects.prepare'],
      resolveActionExecutor: request => ({ execute: async (actionId, input, context) => {
        const result = await createProjectFiniteAction(runtime, request.ingress ?? { signal })({ actionId, input,
          context: { ...context, serverId: 'home' } });
        return result && typeof result === 'object' && 'ok' in result
          ? result as import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteResult
          : { ok: true, result };
      } }),
    });
    const handler = handlers.get(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.prepare'])!;
    const input = { workspace: { serverId: 'home', machineId: 'machine', rootPath: '/accepted', workspaceId: 'accepted' }, phase: 'setup' };
    await expect(handler(input, { signal })).resolves.toMatchObject({ ok: false, errorCode: 'machine_admission_required' });
    const ingress: RpcHandlerContext = { signal, machineAdmission: { actorAccountId: 'teammate', custodianAccountId: 'owner',
      machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    await expect(handler(input, ingress)).resolves.toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
    await expect(handler(input, { ...ingress, machineAdmission: { ...ingress.machineAdmission!, actorAccountId: 'owner' },
      verifyMachineAdmissionCurrent: async () => false })).resolves.toMatchObject({ ok: false, errorCode: 'machine_admission_changed' });
    expect(runtime.workerAdmission.dependencies()).toEqual([]);
    terminalSessions.dispose();
  });
});
