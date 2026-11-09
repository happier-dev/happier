import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, type MachineRpcAdmissionBoundary } from '@/api/machine/machineRpcAuthorization';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { registerActionSpecRpcHandlers, unwrapActionResultForRpc } from './registerActionSpecRpcHandlers';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

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
      nativeIo: { resolveTool: noEffect }, environmentIo: { resolveTool: noEffect, run: noEffect,
        createInvocation: () => { throw new Error('No native invocation is admitted'); } },
      terminalSessions,
    };
    const keys = tweetnacl.sign.keyPair();
    // Only Home HTTP is substituted; the receiver signs and verifies arrival
    // admission before its real registered factory can use Account/process ports.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine',
      resolveInstallationId: () => 'installation', resolveCustodianAccountId: async () => 'owner',
      resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
        daemonToken: 'receiver', serverHttpBaseUrl: 'https://home.invalid' }) };
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
    registerActionSpecRpcHandlers<'projects.prepare'>({
      rpcHandlerManager: rpc,
      targetMachineId: 'machine', actionIds: ['projects.prepare'],
      resolveActionExecutor: request => ({ execute: async (actionId, input, context) => {
        const ingress = request.ingress ?? { signal };
        const result = await createProjectFiniteAction({ ...runtime,
          requesterIdentity: selectHostRequesterExecutionIdentity({ rpcContext: ingress, hostHomeServerIdentityId: 'home' }) }, ingress)({ actionId, input,
          context: { ...context, serverId: 'home' } });
        return result && typeof result === 'object' && 'ok' in result
          ? result as import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteResult
          : { ok: true, result };
      } }),
    });
    const input = { workspace: { serverId: 'home', machineId: 'machine', rootPath: '/accepted', workspaceId: 'accepted' }, phase: 'setup' };
    const request = { method: `machine:${PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.prepare']}`,
      params: input, callerAuthority: 'present_user' as const };
    const machineAdmission: NonNullable<RpcHandlerContext['machineAdmission']> = { actorAccountId: 'teammate', custodianAccountId: 'owner',
      machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' };
    try {
      await expect(rpc.handleRequest(request)).resolves.toMatchObject({ ok: false, errorCode: 'machine_admission_required' });
      await expect(rpc.handleRequest({ ...request, machineAdmission }))
        .resolves.toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable' });
      expect(network).toHaveBeenCalledTimes(1);
      await expect(rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission, installationId: 'replaced-installation' } }))
        .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(network).toHaveBeenCalledTimes(1);
      network.mockResolvedValue({ status: 403, data: { v: 1, ok: false }, statusText: 'Forbidden',
        headers: {}, config: { headers: new AxiosHeaders() } });
      await expect(rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission, actorAccountId: 'owner' } }))
        .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(network).toHaveBeenCalledTimes(2);
      expect(runtime.workerAdmission.dependencies()).toEqual([]);
    } finally { network.mockRestore(); terminalSessions.dispose(); }
  });
});
