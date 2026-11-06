import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS, type WorkspaceSyncSourceRoutingV1 } from '@happier-dev/protocol/socketRpc';

import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, verifyManagedActivityTargetCurrent, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';
import { logger } from '@/ui/logger';

describe('authorizeMachineRpcRequest', () => {
  it('uses declared Machine scope only after exact current custodian admission, without weakening Session writes', async () => {
    const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    let current = true;
    // The Home verification callback is the network boundary; local target,
    // installation, actor and method-scope checks remain real.
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveCustodianAccountId: async () => 'alice', verifyMachineAdmission: async () => current };
    for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_STOP, SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1]) {
      const request = { method: `machine:${method}`, params: { runId: 'run' }, machineAdmission };
      expect(await authorizeMachineRpcRequest(request, boundary), method).toEqual({ ok: true });
      for (const refused of [
        { ...request, machineAdmission: undefined },
        { ...request, method: `other-machine:${method}` },
        { ...request, machineAdmission: { ...machineAdmission, installationId: 'replaced-installation' } },
        { ...request, machineAdmission: { ...machineAdmission, actorAccountId: 'bob', role: 'use' as const } },
        { ...request, authorization: { kind: 'session.write' as const, sessionId: 'session' } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      current = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, admissionPredicate: 'machine_currentness' });
      current = true;
    }
    expect(await authorizeMachineRpcRequest({ method: `machine:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`,
      params: { sessionId: 'session' }, machineAdmission }, boundary))
      .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    expect(await authorizeMachineRpcRequest({ method: `session:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`,
      params: { sessionId: 'session', runId: 'run' }, authorization: { kind: 'session.write', sessionId: 'session' } }, boundary)).toEqual({ ok: true });
  });
  it('binds strict personal copy previews to either the controller or the physical target without widening other Machine requests', async () => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const params = { kind: 'preview', workspace: { serverId: 'home', refId: 'source' }, machineId: 'controller',
      targetMachineId: 'target', targetWorkspaceRefId: 'copy', expectedRelationship: {
        v: 1, relationshipId: 'copy-link', controllerMachineId: 'controller', alphaWorkspaceRefId: 'source',
        betaWorkspaceRefId: 'copy', mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 2,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      } };
    let current = true;
    for (const machineId of ['controller', 'target']) {
      const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId,
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
      const boundary: MachineRpcAdmissionBoundary = { machineId, resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async () => current };
      const request = { method: `${machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params, machineAdmission };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      for (const refused of [
        { ...request, machineAdmission: { ...machineAdmission, installationId: 'replaced-installation' } },
        { ...request, machineAdmission: { ...machineAdmission, custodianAccountId: 'foreign-owner' } },
        { ...request, method: `foreign-machine:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}` },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      if (machineId === 'target') {
        for (const refused of [
          { ...request, params: { ...params, targetMachineId: 'foreign-target' } },
          { ...request, params: { ...params, expectedRelationship: undefined } },
          { ...request, params: { ...params, rootPath: '/caller-selected-root' } },
          { ...request, params: { ...params, kind: 'remove' } },
          { ...request, method: `${machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE}` },
          { ...request, method: `${machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}` },
        ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      }
      current = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      current = true;
    }
  });
  it('distinguishes Home response, schema, transport and cancellation failures without logging credentials or payloads', async () => {
    const context = { actorAccountId: 'never-log-actor', custodianAccountId: 'never-log-owner', machineId: 'never-log-machine',
      installationId: 'never-log-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const key = tweetnacl.sign.keyPair();
    const record = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const network = vi.spyOn(axios, 'post');
    const input = { context, method: `${context.machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`,
      privateKey: key.secretKey, daemonToken: 'never-log-token', serverHttpBaseUrl: 'https://never-log-home.invalid' };
    try {
      network.mockResolvedValueOnce({ status: 429, data: { error: 'never-log-body' } });
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'response_status', status: 429,
      });
      network.mockResolvedValueOnce({ status: 200, data: { v: 1, ok: true, unexpected: 'never-log-value' } });
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'response_schema', status: 200,
      });
      network.mockRejectedValueOnce(new Error('never-log-transport-secret'));
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'transport',
      });
      network.mockRejectedValueOnce(new axios.AxiosError('never-log-network-message', 'ECONNRESET'));
      expect(await verifyMachineRpcAdmissionCurrent({ ...input, method: 'never-log-machine:never-log-method' })).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: '<unregistered>', stage: 'transport', transportCode: 'ECONNRESET',
      });
      const controller = new AbortController();
      network.mockImplementationOnce(async () => {
        controller.abort();
        throw new axios.CanceledError('never-log-cancel-message');
      });
      expect(await verifyMachineRpcAdmissionCurrent({ ...input, signal: controller.signal })).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'request_cancelled',
      });
      expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
    } finally { network.mockRestore(); record.mockRestore(); }
  });
  it('admits prepared Machine phases after current Home admission while retaining Session attachment admission', async () => {
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const signing = tweetnacl.sign.keyPair();
    // Only the Home HTTP boundary is substituted; the signing and admission owners remain real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({
        ...input, privateKey: signing.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid',
      }) };
    const request = { method: `machine:${RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT}`, machineAdmission,
      params: { t: 'prepared_machine_transfer_v1', path: '/machine-transfers/direct/YmluYXJ5/open', httpMethod: 'POST',
        authorizationToken: 'prepared-token', recipientPublicKeyBase64: 'recipient' } };
    try {
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      for (const refused of [
        { ...request, machineAdmission: undefined },
        { ...request, method: `machine:${RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK}` },
        { ...request, params: { t: 'session_file_download_v1', path: '/private/file' } },
        { ...request, params: { t: 'session_attachment_download_v1', attachmentHandle: { sessionId: 'session' } } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      network.mockResolvedValue({ status: 403, data: { v: 1, ok: false }, statusText: 'Forbidden',
        headers: {}, config: { headers: new AxiosHeaders() } });
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });
  it.each([RPC_METHODS.SESSION_FORK, RPC_METHODS.SESSION_FORK_PROVIDER_SAFE, RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY])(
    'binds %s to the source Session in the decrypted request', async method => {
      const params = method === RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY
        ? { replay: { previousSessionId: 'source-session' } }
        : { parentSessionId: 'source-session', sessionId: 'untrusted-selector' };
      const request = { method: `machine:${method}`, params,
        authorization: { kind: 'session.write' as const, sessionId: 'source-session' } };
      expect(await authorizeMachineRpcRequest(request)).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ ...request, authorization: undefined }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.write', sessionId: 'untrusted-selector' } }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    },
  );
  it.each([RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ])(
    'admits %s through the connected Home regardless of caller-local labels, retaining Machine custody', async method => {
      const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
      let current = true;
      let installationId = 'installation';
      const boundary = { machineId: 'machine', resolveInstallationId: () => installationId,
        resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async () => current };
      const request = { method: `machine:${method}`, params: { serverId: 'browser-local-home', machineId: 'machine' }, machineAdmission };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      for (const refused of [
        { ...request, params: { ...request.params, machineId: 'another-machine' } },
        { ...request, machineAdmission: { ...machineAdmission, machineId: 'another-machine' } },
        { ...request, machineAdmission: { ...machineAdmission, custodianAccountId: 'another-owner' } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      installationId = 'replacement';
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      installationId = 'installation';
      current = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    },
  );
  it('verifies physical TARGET preflight with the parent key while preserving the admitted shared child and read-only ceiling', async () => {
    const machineAdmission = { actorAccountId: 'shared-actor', custodianAccountId: 'owner', machineId: 'target-child',
      installationId: 'target-child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const receiver = { machineId: 'parent', installationId: 'parent-installation' };
    const workspaceSyncTargetRouting = { v: 1 as const, phase: 'preflight' as const, operationId: 'move-target',
      accountServerId: 'home-1', targetMachineId: 'target-child', targetRootPath: '/child/workspace', targetContext: {
        machineAdmission, callerAuthority: 'account_automation' as const, workspaceWrites: 'deny' as const,
      } };
    const method = `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
    const params = { v: 1, operationId: 'move-target', serverId: 'home-1', machineId: 'target-child', targetPath: '/child/workspace' };
    const key = tweetnacl.sign.keyPair();
    let currentParentInstallation = receiver.installationId;
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(url).toBe('https://home.invalid/v1/machines/parent/admission/verify');
      const body = raw as { context: typeof machineAdmission; method: string; workspaceSyncTargetRouting: typeof workspaceSyncTargetRouting;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(machineAdmission);
      expect(body.workspaceSyncTargetRouting).toEqual(workspaceSyncTargetRouting);
      const payload = { version: 1 as const, ...receiver, accountId: 'owner',
        rpcAdmission: { context: body.context, method: body.method, workspaceSyncTargetRouting: body.workspaceSyncTargetRouting } };
      expect(verifyMachineInstallationProof({ payload, proof: body.proof, publicKey: key.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission,
        workspaceSyncTargetRouting: { ...workspaceSyncTargetRouting, targetMachineId: 'foreign-child' } } },
        proof: body.proof, publicKey: key.publicKey })).toBe(false);
      return { status: currentParentInstallation === receiver.installationId ? 200 : 403, data: { v: 1, ok: true },
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const boundary = { machineId: 'parent', resolveInstallationId: () => currentParentInstallation,
      resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async (received) => {
        const verification = { ...received, workspaceSyncTargetReceiver: receiver, privateKey: key.secretKey,
          daemonToken: 'parent-custodian-token', serverHttpBaseUrl: 'https://home.invalid' };
        return await verifyMachineRpcAdmissionCurrent(verification);
      } } satisfies MachineRpcAdmissionBoundary;
    try {
      const request = { method, params, machineAdmission, workspaceSyncTargetRouting };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      network.mockClear();
      for (const refused of [
        { ...request, workspaceSyncTargetRouting: undefined },
        { ...request, method: 'parent:spawn-happy-session' },
        { ...request, workspaceSyncTargetRouting: { ...workspaceSyncTargetRouting, operationId: 'foreign-operation' } },
        { ...request, workspaceSyncTargetRouting: { ...workspaceSyncTargetRouting, targetMachineId: 'foreign-child' } },
        { ...request, params: { ...params, serverId: 'foreign-home' } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(network).not.toHaveBeenCalled();
      currentParentInstallation = 'replacement-installation';
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });

  it('verifies physical SOURCE custody with the parent key without replacing the original child actor or grant', async () => {
    const machineAdmission = { actorAccountId: 'shared-actor', custodianAccountId: 'owner', machineId: 'child',
      installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const receiver = { machineId: 'parent', installationId: 'parent-installation' };
    const workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1 = { v: 1, phase: 'prepare', operationId: 'move-1',
      accountServerId: 'home-1', sourceMachineId: 'child', sourceRootPath: '/child/workspace', sourceSessionId: 'session-1' };
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const params = { v: 1 as const, phase: 'prepare' as const, input: {
      operationId: 'move-1', accountServerId: 'home-1', sourceSessionId: 'session-1', action: { kind: 'copy_once' as const, contentPolicy },
      sourceMachineId: 'child', sourceRootPath: '/child/workspace', targetMachineId: 'target', targetRootPath: '/target/workspace',
    } };
    const method = `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
    const keyPair = tweetnacl.sign.keyPair();
    let parentInstallation = receiver.installationId;
    let sourceCurrent = true;
    const admittedProofs: unknown[] = [];
    // Only the Home HTTP boundary is substituted; the actual admission owner and signing are exercised.
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(url).toBe('https://home.invalid/v1/machines/parent/admission/verify');
      const body = raw as { context: typeof machineAdmission; method: string; workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(machineAdmission);
      expect(body.workspaceSyncSourceRouting.operationId).toBe('move-1');
      const payload = { version: 1 as const, ...receiver, accountId: 'owner',
        rpcAdmission: { context: body.context, method: body.method, workspaceSyncSourceRouting: body.workspaceSyncSourceRouting } };
      expect(verifyMachineInstallationProof({ payload, proof: body.proof, publicKey: keyPair.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission,
        workspaceSyncSourceRouting: { ...body.workspaceSyncSourceRouting, sourceRootPath: '/foreign' } } },
        proof: body.proof, publicKey: keyPair.publicKey })).toBe(false);
      admittedProofs.push(body);
      const cleanup = body.workspaceSyncSourceRouting.phase === 'abort' || body.workspaceSyncSourceRouting.phase === 'commit';
      const current = (sourceCurrent || cleanup) && parentInstallation === receiver.installationId;
      return { status: current ? 200 : 403, data: { v: 1, ok: current },
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const boundary = { machineId: receiver.machineId, resolveCustodianAccountId: async () => 'owner',
      resolveInstallationId: () => parentInstallation,
      verifyMachineAdmission: async (input) => {
        const verification = { ...input, workspaceSyncSourceReceiver: receiver, privateKey: keyPair.secretKey,
          daemonToken: 'parent-daemon-token', serverHttpBaseUrl: 'https://home.invalid' };
        return await verifyMachineRpcAdmissionCurrent(verification);
      } } satisfies MachineRpcAdmissionBoundary;
    try {
      const request = { method, params, machineAdmission, workspaceSyncSourceRouting };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      const admitted = admittedProofs.splice(0);
      expect(admitted).toHaveLength(1);
      for (const refused of [
        { ...request, workspaceSyncSourceRouting: undefined },
        { ...request, method: 'parent:spawn-happy-session' },
        { ...request, machineAdmission: { ...machineAdmission, machineId: 'foreign-child' } },
        { ...request, workspaceSyncSourceRouting: { ...workspaceSyncSourceRouting, operationId: 'foreign-operation' } },
        { ...request, params: { ...params, input: { ...params.input, sourceRootPath: '/foreign' } } },
        { ...request, params: { ...params, input: { ...params.input, sourceSessionId: 'foreign-session' } } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(admittedProofs).toEqual([]);
      sourceCurrent = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      const abortRequest = { ...request, params: { ...params, phase: 'abort' as const },
        workspaceSyncSourceRouting: { ...workspaceSyncSourceRouting, phase: 'abort' as const } };
      expect(await authorizeMachineRpcRequest(abortRequest, boundary)).toEqual({ ok: true });
      parentInstallation = 'replacement-parent-installation';
      expect(await authorizeMachineRpcRequest(abortRequest, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });
  it('binds managed guest verification to the exact signed row, controller, actor and installation', async () => {
    const context = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'guest',
      installationId: 'guest-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const target = { homeId: 'home', managedId: 'managed', expectedRevision: 4,
      controller: { machineId: 'controller', installationId: 'controller-installation' } };
    const keyPair = tweetnacl.sign.keyPair();
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { current: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    try {
      expect(await verifyManagedActivityTargetCurrent({ context, managedTarget: target, method: 'managed.activity.read',
        privateKey: keyPair.secretKey, daemonToken: 'guest-token', serverHttpBaseUrl: 'https://home.invalid' })).toBe(true);
      const body = network.mock.calls[0]?.[1] as { method: string;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.method).toBe('guest:managed.activity.read');
      const payload = { version: 1 as const, machineId: context.machineId, installationId: context.installationId,
        accountId: context.custodianAccountId, rpcAdmission: { context, method: body.method, managedTarget: target } };
      expect(verifyMachineInstallationProof({ payload, proof: body.proof, publicKey: keyPair.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload,
        rpcAdmission: { ...payload.rpcAdmission, managedTarget: { ...target, expectedRevision: 5 } } },
        proof: body.proof, publicKey: keyPair.publicKey })).toBe(false);
      network.mockResolvedValueOnce({ status: 200, data: { current: false }, statusText: 'OK', headers: {},
        config: { headers: new AxiosHeaders() } });
      expect(await verifyManagedActivityTargetCurrent({ context, managedTarget: target, method: 'managed.activity.read',
        privateKey: keyPair.secretKey, daemonToken: 'guest-token', serverHttpBaseUrl: 'https://home.invalid' })).toBe(false);
    } finally { network.mockRestore(); }
  });
  it('binds protected current-service admission to the current installation without substituting the custodian actor', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
      installationId: 'installation-a', role: 'use' as const, encryptionMode: 'e2ee' as const };
    let current = true;
    let installationId = 'installation-a';
    const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => installationId, verifyMachineAdmission: async (input: {
        context: { actorAccountId: string; custodianAccountId: string };
      }) => current && input.context.actorAccountId === 'bob' && input.context.custodianAccountId === 'alice' };
    const request = { method: 'machine-a:daemon.localServices.preview.admission', params: { v: 1, kind: 'read' },
      machineAdmission, authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } };
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    const forgedRequest = { ...request, authorization: { ...request.authorization, forged: true } };
    expect(await authorizeMachineRpcRequest(forgedRequest, boundary))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = false;
    expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = true;
    installationId = 'replacement';
    expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('refuses current-service admission without protected origin and current Machine admission', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
      installationId: 'installation-a', role: 'use' as const, encryptionMode: 'e2ee' as const };
    const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => 'installation-a', verifyMachineAdmission: async () => true };
    const request = { method: 'machine-a:daemon.localServices.preview.admission', params: { v: 1, kind: 'read' } };
    for (const refused of [request, { ...request, machineAdmission },
      { ...request, machineAdmission, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN },
      { ...request, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION, machineAdmission,
        authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } },
      { ...request, method: `machine-a:other:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`, machineAdmission,
        authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } }]) {
      expect(await authorizeMachineRpcRequest(refused, boundary))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(await authorizeMachineRpcRequest({ ...request, machineAdmission,
      authorization: { kind: 'localServices.preview.admission.serverOrigin' } }))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('binds the strict access-loss subject to current Home verification', async () => {
    const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine-a',
      installationId: 'installation-a', role: 'manage' as const, encryptionMode: 'plain' as const };
    const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => 'installation-a',
      // The Home service admits only the exact subject whose structural access remains lost.
      verifyMachineAdmission: async (input: { custodySubjectAccountId?: string }) => input.custodySubjectAccountId === 'bob' };
    const request = { method: `machine-a:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      params: { v: 1, subjectAccountId: 'bob' }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, machineAdmission };
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    expect(await authorizeMachineRpcRequest({ ...request, params: { ...request.params, serverId: 'forged' } }, boundary))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('keeps workspace SCM calls detached and accepts only the separately stamped Session scope', async () => {
    for (const method of ['scm.diffSummary.generate', 'scm.diffSummary.result.read']) {
      expect(await authorizeMachineRpcRequest({ method: `machine-1:${method}`, params: { sessionId: 'selector' } })).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ method: `machine-1:${method}`, params: {},
        authorization: { kind: 'session.write', sessionId: 'authorized-session' } })).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ method: `machine-1:${method}`, params: {},
        authorization: { kind: 'automation.replyHandoff.serverOrigin' } })).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
  });
  it('binds current verification to the custodian installation and exact original RPC method', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice',
      machineId: 'alice-machine', installationId: 'alice-installation',
      role: 'use' as const, encryptionMode: 'e2ee' as const };
    const method = 'alice-machine:spawn-happy-session';
    const keyPair = tweetnacl.sign.keyPair();
    // Axios is the Home network boundary; signing and admission remain real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    try {
      expect(await verifyMachineRpcAdmissionCurrent({ context: machineAdmission, method,
        privateKey: keyPair.secretKey, daemonToken: 'alice-daemon-token', serverHttpBaseUrl: 'https://home.invalid' })).toBe(true);
      const body = network.mock.calls[0]?.[1];
      const parsed = body as { context: typeof machineAdmission; method: string;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const payload = { version: 1 as const, installationId: machineAdmission.installationId,
        machineId: machineAdmission.machineId, accountId: machineAdmission.custodianAccountId,
        rpcAdmission: { context: parsed.context, method: parsed.method } };
      expect(verifyMachineInstallationProof({ payload, proof: parsed.proof, publicKey: keyPair.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload,
        rpcAdmission: { context: { ...parsed.context, actorAccountId: 'alice' }, method } },
        proof: parsed.proof, publicKey: keyPair.publicKey })).toBe(false);
      network.mockResolvedValueOnce({ status: 403, data: { v: 1, ok: false, code: 'access_denied' },
        statusText: 'Forbidden', headers: {}, config: { headers: new AxiosHeaders() } });
      expect(await verifyMachineRpcAdmissionCurrent({ context: machineAdmission, method,
        privateKey: keyPair.secretKey, daemonToken: 'alice-daemon-token', serverHttpBaseUrl: 'https://home.invalid' })).toBe(false);
    } finally { network.mockRestore(); }
  });
  it('admits the authenticated actor on the exact custodian installation and refuses revoked admission', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice',
      machineId: 'alice-machine', installationId: 'alice-installation',
      role: 'use' as const, encryptionMode: 'e2ee' as const };
    let current = true;
    const boundary = {
      machineId: 'alice-machine',
      resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => 'alice-installation',
      verifyMachineAdmission: async () => current,
    };
    const request = { method: `alice-machine:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`,
      params: { sessionId: 'bob-session' }, machineAdmission };
    await expect(authorizeMachineRpcRequest(request, boundary)).resolves.toEqual({ ok: true });
    current = false;
    await expect(authorizeMachineRpcRequest(request, boundary)).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = true;
    await expect(authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, installationId: 'replacement' } }, boundary))
      .resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    await expect(authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, custodianAccountId: 'bob' } }, boundary))
      .resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it.each([RPC_METHODS.SESSION_CONTINUATION_INSPECT, RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH,
    RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW])('binds continuation read authority to the decrypted Session: %s', async method => {
    const sessionField = method === RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW ? 'sessionId' : 'sourceSessionId';
    const request = { method: `machine-1:${method}`, params: { [sessionField]: 'own-session' } };
    expect(await authorizeMachineRpcRequest(request)).toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.write', sessionId: 'own-session' } }))
      .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.read', sessionId: 'other-session' } }))
      .toMatchObject({ ok: false, admissionPredicate: 'session_target' });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.read', sessionId: 'own-session' } }))
      .toEqual({ ok: true });
  });

  it('allows machine RPC methods that do not require session-write authorization', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({ ok: true });
  });

  it('never spends a Session read proof on a mutation', async () => {
    expect(await authorizeMachineRpcRequest({ method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'own-session' }, authorization: { kind: 'session.read', sessionId: 'own-session' } }))
      .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
  });

  it('rejects session-write RPCs without authorization', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('accepts the released server-v0.2.1 Stop shape without a server authorization envelope', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
      transportResponseEnvelopeVersion: undefined,
    })).resolves.toEqual({ ok: true });
  });

  it('keeps current Stop requests fail-closed when the server authorization proof is absent', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
      transportResponseEnvelopeVersion: 1,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('requires the same session-write authorization for recovery restart V2', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('rejects session-write RPCs when decrypted params target another session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_2' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_target',
    });
  });

  it('allows session-write RPCs when authorization and decrypted params target the same session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_1' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({ ok: true });
  });

  it('requires matching Session authorization for remote grant inventory and revocation', async () => {
    for (const method of [
      'session.permission.remote.grants.list',
      'session.permission.remote.grants.revoke',
    ]) {
      await expect(authorizeMachineRpcRequest({
        method: `sess_1:${method}`,
        params: { sessionId: 'sess_1' },
        authorization: undefined,
      })).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      await expect(authorizeMachineRpcRequest({
        method: `sess_1:${method}`,
        params: { sessionId: 'sess_1' },
        authorization: {
          kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
          sessionId: 'sess_1',
        },
      })).resolves.toEqual({ ok: true });
    }
  });

  it('rejects a Session Agent transition with no server-provided edit proof', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('rejects a Session Agent transition whose edit proof names another Session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_2' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_target',
    });
  });

  it('allows a Session Agent transition whose edit proof matches the decrypted request', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_1' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({ ok: true });
  });

});
