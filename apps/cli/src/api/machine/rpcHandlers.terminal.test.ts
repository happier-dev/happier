import { Buffer } from 'node:buffer';
import axios from 'axios';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  TERMINAL_STREAM_MAX_FRAMES,
  TerminalStreamReadResponseSchema,
  decodeTerminalStreamBytesFrame,
  type TerminalStreamBytesFrame,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyProcess, PtyProvider, PtySpawnParams } from '@/terminal/pty/provider';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
// The in-memory RPC transport erases registered callback types; real handlers validate incoming request bodies.
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectFiniteAction, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { reviewProjectSetupEffect } from '@/workspaces/projectSetup/projectSetupPreparation';
import { createProjectSetupSuccessStore } from '@/workspaces/projectSetup/projectSetupSuccess';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import nacl from 'tweetnacl';

class FakePty implements PtyProcess {
  readonly pid = 4321;
  write(): void { }
  resize(): void { }
  kill(): void { }
  onData(_listener: (data: string) => void): { dispose: () => void } { return { dispose: () => { } }; }
  onExit(_listener: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose: () => void } {
    return { dispose: () => { } };
  }
}

class FakePtyProvider implements PtyProvider {
  public readonly spawned: PtySpawnParams[] = [];

  spawn(params: PtySpawnParams): PtyProcess {
    this.spawned.push(params);
    return new FakePty();
  }
}

class FakeInteractivePty implements PtyProcess {
  constructor(readonly pid = 4343) {}
  get ownedProcessGroupId(): number { return this.pid; }
  exited = false;
  readonly writes: string[] = [];
  private readonly onDataBytesListeners = new Set<(data: Buffer | string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private pendingLine = '';
  resizeError: Error | null = null;

  write(data: string): void {
    const chunk = String(data);
    this.writes.push(chunk);
    this.pendingLine += chunk.replace(/\r/g, '\n');
    if (!this.pendingLine.includes('\n')) {
      return;
    }

    const [line, ...rest] = this.pendingLine.split('\n');
    this.pendingLine = rest.join('\n');
    this.emitBytes(Buffer.from(`ran:${line.trim()}\r\n`, 'utf8'));
  }

  resize(): void { if (this.resizeError) throw this.resizeError; }
  kill(): void { }
  onData(_listener: (data: string) => void): { dispose: () => void } { return { dispose: () => { } }; }
  onDataBytes(listener: (data: Buffer | string) => void): { dispose: () => void } {
    this.onDataBytesListeners.add(listener);
    return {
      dispose: () => {
        this.onDataBytesListeners.delete(listener);
      },
    };
  }
  onExit(listener: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose: () => void } {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }
  exit(exitCode: number): void { this.exited = true; for (const listener of this.exitListeners) listener({ exitCode }); }

  emitBytes(data: Buffer | string): void {
    for (const listener of this.onDataBytesListeners) {
      listener(data);
    }
  }
}

class FakeInteractivePtyProvider implements PtyProvider {
  public readonly spawned: Array<{ params: PtySpawnParams; pty: FakeInteractivePty }> = [];
  onSpawn?: (params: PtySpawnParams) => void;

  spawn(params: PtySpawnParams): PtyProcess {
    const pty = new FakeInteractivePty(4343 + this.spawned.length);
    this.spawned.push({ params, pty });
    this.onSpawn?.(params);
    return pty;
  }
}

describe('registerMachineTerminalRpcHandlers', () => {
  it('opens and reconnects Bob accepted Project shell through private Account ports on Alice installation without a Session', async () => {
    const h = await finiteHarness({ observeInteractiveStop: true, maxSessions: 2 });
    let live = true;
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'bob-terminal-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'machines.terminal.open', requestId: 'bob-open', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } });
    h.get.mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const originalPost = h.post.getMockImplementation()!;
    h.post.mockImplementation(async (...args) => String(args[0]).endsWith('/execution-authorization/verify')
      ? { status: live ? 200 : 403, data: live ? { ok: true } : {} } : originalPost(...args));
    const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const http = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: 'home',
      serverIdentityId: 'stable-home', serverHttpBaseUrl: h.runtime.serverHttpBaseUrl, target: root.binding.target,
      installationId: 'installation', privateKey: key.secretKey, isCurrent: async () => live });
    if (!http) throw new Error('Original requester HTTP projection missing');
    const authorization = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: 'stable-home',
      bootstrap: { credentials: { token: 'bob-token', encryption: null }, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl,
        attribution: { serverId: 'home', accountId: 'bob', machineId: 'machine', installationId: 'installation' }, isCurrent: async () => live } });
    if (!authorization) throw new Error('Requester Account projection missing');
    const { credentials: _custodian, ...ports } = h.runtime;
    const runtime = { ...ports, accountId: 'bob', accountAuthorization: authorization,
      isCurrent: async () => live && await authorization.requesterAccountProjection!.isCurrent() };
    const context: RpcHandlerContext = { ...h.ingress, callerInputAuthorization: authorization,
      machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'bob', custodianAccountId: 'alice', role: 'use' },
      verifyMachineAdmissionCurrent: async () => live };
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
      deps: { serverId: 'home', env: {}, workingDirectory: h.root, sessionManager: h.sessionManager, projectFiniteRuntime: async () => runtime } });
    const input = { terminalKey: 'bob-shell', workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root } };
    let disposeOwnSession: (() => void) | undefined;
    try {
      const opened = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, context);
      expect(opened).toMatchObject({ ok: true, reused: false, terminalId: expect.any(String) });
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Bob shell missing');
      const terminalId = opened.terminalId;
      expect(h.sessionManager.getCustody(terminalId)).toMatchObject({ requesterAccountId: 'bob', installationId: 'installation', workspaceRefId: 'accepted' });
      expect(h.sessionManager.list()[0]?.sessionId).toBeUndefined();
      const reconnect = { ...context, signal: new AbortController().signal };
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, reconnect)).resolves.toMatchObject({ ok: true, reused: true, terminalId });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({}, reconnect)).resolves.toMatchObject({ terminals: [{ terminalId }] });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId, data: 'echo bob\n' }, reconnect)).resolves.toMatchObject({ ok: true });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESIZE)!({ terminalId, cols: 100, rows: 30 }, reconnect)).resolves.toMatchObject({ ok: true });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)!({ terminalId, cursor: 0 }, reconnect)).resolves.toMatchObject({ ok: true });
      const cara = { ...reconnect, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'cara' } };
      for (const [method, params] of [[RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId, data: 'stolen' }],
        [RPC_METHODS.DAEMON_TERMINAL_RESIZE, { terminalId, cols: 80, rows: 24 }],
        [RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId }], [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, { terminalId, cursor: 0 }]] as const) {
        await expect(handlers.get(method)!(params, cara)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      }
      expect(h.provider.spawned).toHaveLength(1);
      let sessionOwner = true;
      h.get.mockImplementation(async (url, options) => {
        if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (String(url).includes('/v2/sessions/')) {
          expect(options?.headers).toMatchObject({ Authorization: 'Bearer bob-token' });
          if (!String(url).includes('/bob-session')) return { status: 404, data: {} };
          return { status: 200, data: { session: { id: 'bob-session', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: h.root }), metadataVersion: 1,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null, responsibleAccountId: null, responsibleAccount: null,
            share: sessionOwner ? null : { accessLevel: 'view', canApprovePermissions: false },
            effectiveAccess: { v: 1, level: sessionOwner ? 'owner' : 'view', sources: sessionOwner ? [{ kind: 'owner' }] : [{ kind: 'direct', shareId: 'share' }],
              capabilities: projectSessionAccessCapabilitiesV1({ owner: sessionOwner, grants: sessionOwner ? [] : [{ accessLevel: 'view', canApprovePermissions: false }] }) },
          } } };
        }
        return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      });
      const sessionHandlers = new Map<string, RpcHandler<unknown, unknown>>();
      const sessionRegistration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { sessionHandlers.set(method, handler); } },
        deps: { serverId: 'home', env: {}, sessionManager: h.sessionManager, ownSessionRuntime: async () => runtime } });
      disposeOwnSession = sessionRegistration.dispose;
      {
        const own = await sessionHandlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'bob-session-shell', sessionId: 'bob-session' }, reconnect);
        expect(own).toMatchObject({ ok: true, terminalId: expect.any(String) });
        if (!own || typeof own !== 'object' || !('terminalId' in own) || typeof own.terminalId !== 'string') throw new Error('Own Session shell missing');
        expect(h.sessionManager.getCustody(own.terminalId)).toMatchObject({ requesterAccountId: 'bob', kind: 'session', sessionId: 'bob-session' });
        await expect(sessionHandlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'guessed', sessionId: 'alice-session' }, reconnect)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
        sessionOwner = false;
        await expect(sessionHandlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId: own.terminalId, data: 'shared-only' }, reconnect)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
        sessionOwner = true;
        await expect(sessionHandlers.get(RPC_METHODS.DAEMON_TERMINAL_CLOSE)!({ terminalId: own.terminalId }, reconnect)).resolves.toMatchObject({ ok: true });
      }
      expect(h.sessionManager.list()).toMatchObject([{ terminalId }]);
      live = false;
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId, data: 'after revoke' }, reconnect)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      await expect(registration.cleanupRequesterMachineTerminals({ serverId: 'home', requesterAccountId: 'bob', machineId: 'machine', installationId: 'installation',
        verifyCurrentMachineAdmission: async () => true })).resolves.toEqual({ kind: 'settled' });
      expect(h.sessionManager.list()).toEqual([]);
      expect(h.provider.spawned[0]!.pty.exited).toBe(true);
      expect(JSON.parse(JSON.stringify(authorization))).toEqual(root);
    } finally { disposeOwnSession?.(); registration.dispose(); await h.dispose(); }
  });
  it('reads retained machine setup output only through the exact admitted machine custody', async () => {
    const h = await finiteHarness();
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
      deps: { serverId: 'home', env: {}, sessionManager: h.sessionManager } });
    try {
      const terminal = h.sessionManager.ensure({ terminalKey: 'setup', cwd: h.root,
        custody: { kind: 'machine', serverId: 'home', requesterAccountId: 'owner', machineId: 'machine', installationId: 'installation', rootPath: h.root } });
      if (!terminal.ok) throw new Error('Setup output terminal missing');
      h.provider.spawned[0]!.pty.emitBytes(Buffer.from('setup output'));
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)!({ terminalId: terminal.terminalId, cursor: 0 }, h.ingress)).resolves.toMatchObject({ ok: true });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({}, h.ingress)).resolves.toMatchObject({ ok: true, terminals: [{ terminalId: terminal.terminalId }] });
      for (const admission of [{ ...h.ingress.machineAdmission!, actorAccountId: 'other' }, { ...h.ingress.machineAdmission!, installationId: 'replaced' }]) {
        await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)!({ terminalId: terminal.terminalId, cursor: 0 }, { ...h.ingress, machineAdmission: admission })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      }
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)!({ terminalId: terminal.terminalId, cursor: 0 }, { ...h.ingress, verifyMachineAdmissionCurrent: async () => false })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
    } finally { registration.dispose(); await h.dispose(); }
  });
  it.each([RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART])('prepares fresh Project shells before %s and refuses without a host fallback', async method => {
    const h = await finiteHarness({ setup: true });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(id, handler) { handlers.set(id, handler as RpcHandler<unknown, unknown>); } },
      deps: { env: {}, sessionManager: h.sessionManager, projectFiniteRuntime: async () => h.runtime } });
    const input = { terminalKey: 'shell', workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root } };
    try {
      await expect(handlers.get(method)!(input, h.ingress)).resolves.toMatchObject({ ok: false, error: 'project_setup_consent_required',
        details: { kind: 'pendingApproval', reviewedEffectDigest: expect.any(String) } });
      await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1, environment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
      await writeFile(join(h.root, 'mise.toml'), '[env]\nVALUE = "native"\n');
      const unavailable = { ...h.runtime, nativeIo: { resolveTool: async () => null } };
      const missingRegistration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(id, handler) { handlers.set(id, handler as RpcHandler<unknown, unknown>); } },
        deps: { env: {}, sessionManager: h.sessionManager, projectFiniteRuntime: async () => unavailable } });
      await expect(handlers.get(method)!(input, h.ingress)).resolves.toMatchObject({ ok: false, error: 'native_tool_unavailable' });
      await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1, devcontainer: {} }));
      // Child namespace inspection reads the published Machine row. A mode-only
      // response is not a Machine; the real no-child row must be represented.
      h.get.mockImplementation(async url => String(url).endsWith('/v1/machines/machine')
        ? { status: 200, data: { machine: { id: 'machine', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0, storageMode: 'plain' } } }
        : { status: 200, data: { mode: 'plain', updatedAt: 1 } });
      await expect(handlers.get(method)!(input, h.ingress)).resolves.toMatchObject({ ok: false, error: 'child_required' });
      expect(h.provider.spawned).toHaveLength(0);
      missingRegistration.dispose();
    } finally { registration.dispose(); await h.dispose(); }
  });

  it('launches an interactive Project shell with the complete native environment and reuses it without activating again', async () => {
    const h = await finiteHarness({ observeInteractiveStop: true });
    await mkdir(join(h.root, '.happier'));
    await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1, environment: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' } }));
    await writeFile(join(h.root, 'mise.toml'), '[env]\nVALUE = "native"\n');
    const nativeRun = vi.fn(async () => ({ exitCode: 0, stdout: 'PATH=/native/bin\0VALUE=native\0' }));
    const nativeIo = { resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }) };
    const environmentIo = { resolveTool: nativeIo.resolveTool, run: nativeRun,
      createInvocation() { return { resolveTool: nativeIo.resolveTool, run: nativeRun }; } };
    const runtime = { ...h.runtime, nativeIo, environmentIo, hostEnvironment: { PATH: '/host/bin', REMOVE: 'ambient' } };
    const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: h.root, projectKey: 'project', createdAtMs: 1 };
    const reviewed = await reviewProjectSetupEffect({ workspace, projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
      requester: { credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl }, purpose: 'setup', platform: { os: 'linux', arch: 'x64' }, nativeIo });
    if (reviewed.kind !== 'reviewed') throw new Error('Native review must resolve');
    const rows = await h.post(`https://home.example${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`);
    h.post.mockImplementation(async url => String(url).endsWith('/project-trust/read')
      ? { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { project: reviewed.plan.project, reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, approvedAtMs: 1 } } } }
      : rows);
    await createProjectSetupSuccessStore({ homeDir: runtime.successHomeDir! }).recordCompletion({ serverId: 'home', machineId: 'machine', workspaceRefId: 'accepted' },
      { v: 1, workspaceRefId: 'accepted', ...reviewed.plan.successBasis, completedAtMs: 1 });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(id, handler) { handlers.set(id, handler as RpcHandler<unknown, unknown>); } },
      deps: { env: { REMOVE: 'ambient' }, sessionManager: h.sessionManager, projectFiniteRuntime: async () => runtime } });
    const input = { terminalKey: 'native-shell', workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root } };
    try {
      const opened = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, h.ingress);
      expect(opened).toMatchObject({ ok: true, reused: false });
      expect(h.provider.spawned[0]!.params.options.env).toMatchObject({ PATH: '/native/bin', VALUE: 'native' });
      expect(h.provider.spawned[0]!.params.options.env).not.toHaveProperty('REMOVE');
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Missing shell');
      expect(h.sessionManager.isFiniteHeld(opened.terminalId)).toBe(false);
      await writeFile(join(h.root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo changed' }] } }));
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, h.ingress)).resolves.toMatchObject({ ok: true, terminalId: opened.terminalId, reused: true });
      expect(nativeRun).toHaveBeenCalledTimes(1);
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!(input, h.ingress)).resolves.toMatchObject({ ok: false, error: 'project_setup_consent_required' });
      expect(h.provider.spawned).toHaveLength(1);
      expect(h.provider.spawned[0]!.pty.exited).toBe(false);
    } finally { registration.dispose(); await h.dispose(); }
  });

  it('prepares fresh Project shells by waiting for trusted setup to settle before opening the dependent shell', async () => {
    const h = await finiteHarness({ setup: true, waived: true });
    const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: h.root, projectKey: 'project', createdAtMs: 1 };
    const reviewed = await reviewProjectSetupEffect({ workspace, projectAssociation: { workspace, project: { serverId: 'home', projectId: 'project' } },
      requester: { credentials: h.runtime.credentials, serverHttpBaseUrl: h.runtime.serverHttpBaseUrl }, purpose: 'setup', platform: { os: 'linux', arch: 'x64' }, nativeIo: h.runtime.nativeIo });
    if (reviewed.kind !== 'reviewed') throw new Error('Setup review must resolve');
    const rows = await h.post(`https://home.example${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`);
    h.post.mockImplementation(async url => String(url).endsWith('/project-trust/read')
      ? { status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { project: reviewed.plan.project, reviewedEffectDigest: reviewed.plan.reviewedEffectDigest, approvedAtMs: 1 } } } }
      : rows);
    const started = new Promise<void>(resolve => { h.provider.onSpawn = () => resolve(); });
    try {
      const opened = h.handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'after-setup',
        workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root } }, h.ingress);
      await started;
      expect(h.provider.spawned).toHaveLength(1);
      expect(h.provider.spawned[0]!.params.args).toContain('echo setup');
      h.provider.spawned[0]!.pty.exit(0);
      const result = await opened;
      expect(result).toMatchObject({ ok: true, reused: false });
      expect(h.provider.spawned).toHaveLength(2);
      expect(h.provider.spawned[1]!.params.args).not.toContain('echo setup');
      if (!result || typeof result !== 'object' || !('terminalId' in result) || typeof result.terminalId !== 'string') throw new Error('Missing dependent shell');
      expect(h.sessionManager.isFiniteHeld(result.terminalId)).toBe(false);
      expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({ state: 'succeeded' });
    } finally { await h.dispose(); }
  });

  it('lists only the currently admitted Project namespace when accepted Projects share a root and logical key', async () => {
    const h = await finiteHarness();
    const provider = new FakeInteractivePtyProvider();
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, env: {}, platform: 'linux',
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const refs = [{ id: 'accepted', projectKey: 'project-one' }, { id: 'other-accepted', projectKey: 'project-two' }];
    const rows = refs.map(ref => {
      const key = { kind: 'workspace-ref', serverId: 'home', id: ref.id };
      return { key, revision: 1, content: { t: 'plain', v: { key, value: { ...ref, serverId: 'home', machineId: 'machine', rootPath: h.root, createdAtMs: 1 } } } };
    });
    h.post.mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows } });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { serverId: 'home', env: {}, workingDirectory: h.root, sessionManager: manager,
        projectFiniteRuntime: async () => ({ ...h.runtime, terminalSessions: manager }) } });
    try {
      const addresses = refs.map(ref => ({ serverId: 'home', workspaceId: ref.id, machineId: 'machine', rootPath: h.root }));
      const terminalIds: string[] = [];
      for (const workspace of addresses) {
        const opened = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'copied-key', workspace }, h.ingress);
        expect(opened).toMatchObject({ ok: true, reused: false });
        if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Project shell missing');
        terminalIds.push(opened.terminalId);
      }
      expect(new Set(terminalIds).size).toBe(2);
      for (const [index, workspace] of addresses.entries()) {
        await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace }, h.ingress)).resolves.toEqual({ ok: true,
          terminals: [expect.objectContaining({ terminalId: terminalIds[index], terminalKey: 'copied-key', cwd: h.root })] });
      }
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({}, h.ingress)).resolves.toMatchObject({ ok: true,
        terminals: terminalIds.map(terminalId => expect.objectContaining({ terminalId })) });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace: { ...addresses[0]!, workspaceId: 'guessed' } }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace: addresses[0] })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      const foreign = { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'cara' } };
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace: addresses[0] }, foreign)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_unavailable' });
      expect(manager.list()).toHaveLength(2);
      h.post.mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [rows[0],
        { key: rows[1]!.key, revision: 2, content: null },
      ] } });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace: addresses[1] }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace: addresses[0] }, h.ingress)).resolves.toEqual({ ok: true,
        terminals: [expect.objectContaining({ terminalId: terminalIds[0] })] });
      h.retire();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({ workspace: addresses[0] }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      expect(provider.spawned).toHaveLength(2);
    } finally { registration.dispose(); await h.dispose(); }
  });

  it('refuses fresh Machine terminal starts and restarts during drain while preserving attached control', async () => {
    const h = await finiteHarness({ observeInteractiveStop: true });
    const admissionDrain = createDaemonAdmissionDrain();
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { serverId: 'home', env: {}, workingDirectory: h.root, sessionManager: h.sessionManager, admissionDrain,
        projectFiniteRuntime: async () => h.runtime } });
    const input = { terminalKey: 'attached', workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root } };
    try {
      const opened = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, h.ingress);
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Initial Project terminal must open');
      admissionDrain.beginUnusedStopDrain();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, h.ingress)).resolves.toMatchObject({ ok: true, terminalId: opened.terminalId, reused: true });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!(input, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_busy' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ ...input, terminalKey: 'fresh' }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_busy' });
      expect(h.provider.spawned).toHaveLength(1);
      expect(h.sessionManager.list()).toMatchObject([{ terminalId: opened.terminalId, ended: false }]);
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId: opened.terminalId, data: 'echo attached\n' }, h.ingress)).resolves.toMatchObject({ ok: true });
      expect(h.provider.spawned[0]!.pty.writes).toEqual(['echo attached\n']);
      admissionDrain.resumeUnusedStop();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!(input, h.ingress)).resolves.toMatchObject({ ok: true, reused: false });
      expect(h.provider.spawned).toHaveLength(2);
    } finally { registration.dispose(); await h.dispose(); }
  });

  it.each(['credentials', 'root', 'drain'] as const)('does not respawn a Project terminal when %s authority retires during observed process stop', async loss => {
    const h = await finiteHarness();
    const provider = new FakeInteractivePtyProvider();
    let releaseStop: (() => void) | undefined;
    let credentialCurrent = true;
    const admissionDrain = createDaemonAdmissionDrain();
    const manager = createTerminalPtySessionManager({ ptyProvider: provider, env: {}, platform: 'linux',
      config: { maxSessions: 1, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 },
      stopProcessTree: async () => { await new Promise<void>(resolve => { releaseStop = resolve; }); provider.spawned[0]!.pty.exit(0); } });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { serverId: 'home', env: {}, workingDirectory: h.root, sessionManager: manager, admissionDrain,
        projectFiniteRuntime: async () => ({ ...h.runtime, terminalSessions: manager, isCurrent: async () => credentialCurrent }) } });
    try {
      const input = { terminalKey: 'shell', workspace: { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root } };
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, h.ingress)).resolves.toMatchObject({ ok: true });
      const restarting = handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!(input, h.ingress);
      await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'));
      if (loss === 'credentials') credentialCurrent = false;
      else if (loss === 'drain') admissionDrain.beginUnusedStopDrain();
      else h.post.mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key: { kind: 'workspace-ref', serverId: 'home', id: 'accepted' }, revision: 2, content: null },
      ] } });
      releaseStop!();
      await expect(restarting).resolves.toMatchObject({ ok: false, errorCode: loss === 'credentials' ? 'terminal_forbidden' : loss === 'drain' ? 'terminal_busy' : 'terminal_cwd_denied' });
      expect(provider.spawned).toHaveLength(1);
      expect(manager.list()).toEqual([]);
    } finally { registration.dispose(); await h.dispose(); }
  });

  it('retains ordinary own Session authority without requiring an accepted Project or borrowing foreign Account ports', async () => {
    const h = await finiteHarness({ observeInteractiveStop: true });
    let owner = true;
    let replacement = true;
    h.get.mockImplementation(async url => String(url).endsWith('/v1/machines')
      ? { status: 200, data: [{ id: 'machine-old', replacedByMachineId: replacement ? 'machine' : 'unrelated' }, { id: 'machine' }, { id: 'unrelated' }] }
      : String(url).includes('/v2/sessions/') ? { status: 200, data: { session: {
      id: 'session-one', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-old', path: '/agent/workspace',
        sessionWorkspaceLocationV1: { v: 1, machineId: 'machine', agentPath: '/agent/workspace', machinePath: h.root } }), metadataVersion: 1,
      agentState: null, agentStateVersion: 0,
      dataEncryptionKey: null, responsibleAccountId: null, responsibleAccount: null,
      share: owner ? null : { accessLevel: 'view', canApprovePermissions: false },
      effectiveAccess: { v: 1, level: owner ? 'owner' : 'view', sources: owner ? [{ kind: 'owner' }] : [{ kind: 'direct', shareId: 'share' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner, grants: owner ? [] : [{ accessLevel: 'view', canApprovePermissions: false }] }) },
    } } } : { status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { serverId: 'home', env: {}, workingDirectory: h.root, sessionManager: h.sessionManager,
        ownSessionRuntime: async () => h.runtime } });
    try {
      const input = { terminalKey: 'shell', sessionId: 'session-one', cwd: h.root };
      const retained = h.sessionManager.ensure(input);
      if (!retained.ok) throw new Error('Retained Session shell missing');
      const opened = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, h.ingress);
      expect(opened).toMatchObject({ ok: true, reused: true, terminalId: retained.terminalId });
      if (!opened || typeof opened !== 'object' || !('terminalId' in opened) || typeof opened.terminalId !== 'string') throw new Error('Session shell missing');
      expect(h.sessionManager.getCustody(opened.terminalId)).toMatchObject({ kind: 'session', sessionId: 'session-one', requesterAccountId: 'owner' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ ...input, cwd: '/agent/workspace' }, h.ingress)).resolves.toMatchObject({ ok: true, reused: true, terminalId: retained.terminalId });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ ...input, cwd: join(h.root, 'unadmitted') }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ ...input, sessionId: 'session-two' }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      const foreign = { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'cara' } };
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!(input, foreign)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId: opened.terminalId, data: 'own\n' }, h.ingress)).resolves.toEqual({ ok: true });
      replacement = false;
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESIZE)!({ terminalId: opened.terminalId, cols: 100, rows: 30 }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      replacement = true;
      owner = false;
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)!({ terminalId: opened.terminalId, cursor: 0 }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      expect(h.sessionManager.list()).toHaveLength(1);
      owner = true;
      h.sessionManager.close({ terminalId: opened.terminalId });
      const legacyRestart = h.sessionManager.ensure({ ...input, terminalKey: 'legacy-restart' });
      if (!legacyRestart.ok) throw new Error('Retained Session restart shell missing');
      const restarted = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!({ ...input, terminalKey: 'legacy-restart' }, h.ingress);
      expect(restarted).toMatchObject({ ok: true, reused: false });
      if (!restarted || typeof restarted !== 'object' || !('terminalId' in restarted) || typeof restarted.terminalId !== 'string') throw new Error('Restarted Session shell missing');
      expect(restarted.terminalId).not.toBe(legacyRestart.terminalId);
      expect(h.provider.spawned).toHaveLength(3);
      expect(h.sessionManager.list()).toHaveLength(1);
      expect(h.sessionManager.getCustody(restarted.terminalId)).toMatchObject({ kind: 'session', sessionId: 'session-one', requesterAccountId: 'owner' });
    } finally { registration.dispose(); await h.dispose(); }
  });

  it('retires only exactly attributed standalone processes after a fresh access-loss check and observes real exit', async () => {
    const provider = new FakeInteractivePtyProvider();
    let releaseStop: (() => void) | undefined;
    const stopped: number[] = [];
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: {}, platform: 'linux',
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 },
      stopProcessTree: async ({ pid }) => {
        if (pid === undefined) throw new Error('PTY process id is missing');
        stopped.push(pid);
        if (stopped.length === 1) await new Promise<void>(resolve => { releaseStop = resolve; });
        provider.spawned.find(entry => entry.pty.pid === pid)!.pty.exit(0);
      },
    });
    const custody = { serverId: 'home', requesterAccountId: 'bob', machineId: 'machine', installationId: 'installation', workspaceRefId: 'accepted', projectKey: 'project', rootPath: '/project' };
    const bob = sessionManager.ensure({ terminalKey: 'shell', cwd: '/project', custody });
    const cara = sessionManager.ensure({ terminalKey: 'shell', cwd: '/project', custody: { ...custody, requesterAccountId: 'cara' } });
    const presentedSession = sessionManager.ensure({ terminalKey: 'session-shell', cwd: '/project', sessionId: 'session-one',
      custody: { kind: 'session', serverId: 'home', requesterAccountId: 'bob', machineId: 'machine', installationId: 'installation', sessionId: 'session-one', rootPath: '/project' } });
    const held = sessionManager.ensure({ terminalKey: 'finite', cwd: '/project', custody, holdUntilExit: true,
      launchProcess: { file: '/managed/tool', args: [] } });
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler() {} }, deps: { env: {}, sessionManager } });
    try {
      const input = { serverId: 'home', requesterAccountId: 'bob', machineId: 'machine', installationId: 'installation', verifyCurrentMachineAdmission: async () => false };
      await expect(registration.cleanupRequesterMachineTerminals(input)).resolves.toEqual({ kind: 'incomplete' });
      expect(stopped).toEqual([]);
      let settled = false;
      const closing = registration.cleanupRequesterMachineTerminals({ ...input, verifyCurrentMachineAdmission: async () => true }).then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'));
      expect(settled).toBe(false);
      expect(bob.ok && sessionManager.list().some(terminal => terminal.terminalId === bob.terminalId)).toBe(true);
      releaseStop!();
      await expect(closing).resolves.toEqual({ kind: 'settled' });
      expect(bob.ok && sessionManager.list().some(terminal => terminal.terminalId === bob.terminalId)).toBe(false);
      expect(cara.ok && sessionManager.list().some(terminal => terminal.terminalId === cara.terminalId)).toBe(true);
      expect(presentedSession.ok && sessionManager.list().some(terminal => terminal.terminalId === presentedSession.terminalId)).toBe(false);
      expect(held.ok && sessionManager.list().some(terminal => terminal.terminalId === held.terminalId)).toBe(true);
      expect(stopped).toEqual([provider.spawned[0]!.pty.pid, provider.spawned[2]!.pty.pid]);
    } finally { registration.dispose(); }
  });

  it('admits a standalone accepted Project shell and rejects guessed ids and next operations after revoke', async () => {
    const h = await finiteHarness({ waived: true });
    try {
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
        deps: { serverId: 'home', env: {}, workingDirectory: h.root, sessionManager: h.sessionManager,
          projectFiniteRuntime: async () => h.runtime } });
      const workspace = { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: h.root };
      const ensured = await handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'shell', workspace }, h.ingress);
      expect(ensured).toMatchObject({ ok: true, reused: false });
      if (!ensured || typeof ensured !== 'object' || !('terminalId' in ensured) || typeof ensured.terminalId !== 'string') throw new Error('Actual terminal missing');
      const terminalId = ensured.terminalId;
      const foreign = { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'cara' } };
      for (const [method, request] of [
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, { terminalId, cursor: 0 }],
        [RPC_METHODS.DAEMON_TERMINAL_INPUT, { terminalId, data: 'guessed\n' }],
        [RPC_METHODS.DAEMON_TERMINAL_RESIZE, { terminalId, cols: 100, rows: 30 }],
        [RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId }],
      ] as const) await expect(handlers.get(method)!(request, foreign)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK)!({ terminalId, ackedByteOffset: 0 }, foreign)).resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
      for (const caller of [undefined, foreign,
        { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, installationId: 'replacement-installation' } },
      ]) {
        await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!({ terminalId, byteOffset: 0 }, caller)).resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
        await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT)!({ terminalId, event: { t: 'text', text: 'guessed' } }, caller)).resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
      }
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({}, foreign)).resolves.toMatchObject({ ok: true, terminals: [] });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'shell', workspace }, foreign)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_unavailable' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'forged', workspace, requesterAccountId: 'owner' }, foreign)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'other-home', workspace: { ...workspace, serverId: 'another-home' } }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
      h.post.mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [{
        key: { kind: 'workspace-ref', serverId: 'home', id: 'accepted' }, revision: 2, content: null,
      }] } });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ)!({ terminalId, cursor: 0 }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({}, h.ingress)).resolves.toMatchObject({ ok: true, terminals: [] });
      h.retire();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_INPUT)!({ terminalId, data: 'revoked\n' }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'shell', workspace }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
      expect(h.provider.spawned[0]!.pty.writes).toEqual([]);
    } finally { await h.dispose(); }
  });

  it('reuses retained target-platform home and root identity while rejecting sibling-prefix Project roots', async () => {
    for (const entry of [
      { platform: 'win32' as const, home: 'C:\\Users\\Alice', accepted: 'c:/users/alice/repo/', requested: 'C:\\Users\\Alice\\repo', sibling: 'C:\\Users\\Alice2\\repo', cwd: '~\\repo' },
      { platform: 'darwin' as const, home: '/Users/alice', accepted: '/Users/alice/repo/', requested: '/Users/alice/repo', sibling: '/Users/alice2/repo', cwd: '~/repo' },
    ]) {
      const h = await finiteHarness({ acceptedRoot: entry.accepted, unenriched: true });
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
        deps: { env: { HOME: entry.home, USERPROFILE: entry.home }, platform: entry.platform, workingDirectory: entry.home,
          accessPolicy: { kind: 'restrictedRoots', roots: [entry.home] }, sessionManager: h.sessionManager,
          projectFiniteRuntime: async () => h.runtime } });
      try {
        const workspace = { serverId: 'home', workspaceId: 'accepted', machineId: 'machine', rootPath: entry.requested };
        const acceptedPath = authorizeFilesystemPath({ targetPath: entry.accepted, defaultDirectory: entry.home,
          accessPolicy: { kind: 'restrictedRoots', roots: [entry.home] }, platform: entry.platform });
        if (!acceptedPath.valid) throw new Error('Target-platform root must resolve');
        // These virtual OS roots cannot exercise current-byte preparation on a
        // Linux host. Existing retained custody exercises the path owner without
        // inventing a Project association for the legacy unenriched row.
        const retained = h.sessionManager.ensure({ terminalKey: 'shell', cwd: acceptedPath.resolvedPath,
          custody: { serverId: 'home', requesterAccountId: 'owner', machineId: 'machine', installationId: 'installation',
            workspaceRefId: 'accepted', projectKey: 'accepted', rootPath: acceptedPath.resolvedPath } });
        expect(retained).toMatchObject({ ok: true });
        await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'shell', workspace, cwd: entry.cwd }, h.ingress)).resolves.toMatchObject({ ok: true });
        expect(h.sessionManager.list()[0]!.cwd.replace(/\\/g, '/').toLowerCase()).toBe(entry.requested.replace(/\\/g, '/').toLowerCase());
        expect(h.sessionManager.getCustody(h.sessionManager.list()[0]!.terminalId)?.projectKey).toBe('accepted');
        await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'sibling', workspace: { ...workspace, rootPath: entry.sibling } }, h.ingress)).resolves.toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
        expect(h.sessionManager.list()).toHaveLength(1);
      } finally { registration.dispose(); await h.dispose(); }
    }
  });

  async function finiteHarness(options: Readonly<{ setup?: boolean; waived?: boolean; acceptedRootTrailingSlash?: boolean; acceptedRoot?: string; unenriched?: boolean; observeInteractiveStop?: boolean; maxSessions?: number }> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-finite-terminal-')));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'web; echo untrusted', packageManager: 'yarn@1', scripts: { dev: 'echo selected' } }));
    if (options.setup) {
      await mkdir(join(root, '.happier'));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } }));
    }
    const workspace = { id: 'accepted', serverId: 'home', machineId: 'machine', rootPath: options.acceptedRoot ?? (options.acceptedRootTrailingSlash ? `${root}/` : root), createdAtMs: 1,
      ...(options.unenriched ? {} : { projectKey: 'project' }) };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (String(url).endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (!String(url).endsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`)) throw new Error('unexpected network request');
      const key = { kind: 'workspace-ref', serverId: 'home', id: workspace.id };
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [{ key, revision: 1, content: { t: 'plain', v: { key, value: workspace } } }] } };
    });
    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: {}, platform: 'linux',
      // The fake forkpty and OS group probe must agree about actual exit;
      // a relay pid or callback alone cannot prove finite tree settlement.
      probeProcessGroup: groupId => {
        const process = provider.spawned.find(entry => entry.pty.ownedProcessGroupId === groupId)?.pty;
        return process ? process.exited ? 'absent' : 'alive' : 'absent';
      }, stopProcessTree: async ({ pid }) => {
      if (options.observeInteractiveStop) provider.spawned.find(entry => entry.pty.pid === pid)!.pty.exit(0);
    },
      config: { maxSessions: options.maxSessions ?? 1, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const operationRuntime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
      custodyBinding: { serverId: 'home', installationId: 'installation' },
      resolveAccountId: async () => 'owner', generateOperationId: () => 'operation' });
    const preference = createWorkspaceExecutionConfigClientV1({ mode: 'plain', material: null, isCurrent: () => true,
      randomBytes: length => new Uint8Array(length), transport: {
        read: async () => ({ status: 'absent' }), mutate: async () => { throw new Error('read only'); },
      } });
    const admissionDrain = createDaemonAdmissionDrain();
    const runtime: ProjectFiniteActionRuntime & { operationRuntime: typeof operationRuntime } = {
      serverId: 'home', machineId: 'machine', accountId: 'owner', credentials: { token: `requester:${root}`, encryption: null }, serverHttpBaseUrl: 'https://home.example',
      operationRuntime, terminalSessions: sessionManager,
      workerAdmission: createProjectWorkerAdmission({ machineId: 'machine', admissionDrain,
        readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'stored', metadataVersion: 1 }) }),
      resolveWorkspaceExecutionConfig: async () => preference,
      nativeIo: { resolveTool: async tool => ({ executablePath: `/managed/${tool}`, version: '1' }) },
      environmentIo: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
      platform: 'linux', arch: 'x64', hostEnvironment: {}, successHomeDir: join(root, 'success'),
    };
    let current = true;
    const ingress: RpcHandlerContext = { signal: new AbortController().signal, transportRequestId: 'mounted-request', callerAuthority: 'account_automation',
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current };
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { env: {}, workingDirectory: root, sessionManager, admissionDrain, projectFiniteRuntime: async () => runtime,
        projectScriptExecutor: (boundRuntime, context) => createCliActionExecutorHarness({ token: runtime.credentials.token, credentials: runtime.credentials,
          isCredentialCurrent: async () => current,
          sessionId: 'cli-global', serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {},
            ...(options.waived ? { approvalWaivedSurfaces: { 'projects.script.run': ['api'], 'projects.prepare': ['api'] } } : {}) }) },
        }, { projectAction: createProjectFiniteAction(boundRuntime, context) }).executor,
      } });
    const invoke = (method: string = RPC_METHODS.DAEMON_TERMINAL_ENSURE, cwd = root, context = ingress) => handlers.get(method)!({
      terminalKey: 'mounted', cwd, launch: { kind: 'package_script', runTargetId: 'web; echo untrusted:dev' },
    }, context);
    return { root, ingress, invoke, handlers, provider, sessionManager, operationRuntime, runtime, admissionDrain, get, post, retire: () => { current = false; },
      dispose: async () => { registration.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); } };
  }

  it('mounts accepted finite work after drain closes and retains the same bytes after a nonzero exit', async () => {
    const h = await finiteHarness({ waived: true, acceptedRootTrailingSlash: true });
    const unsubscribe = h.runtime.workerAdmission.subscribe(() => {
      if (h.runtime.workerAdmission.dependencies().some(dependency => dependency.state === 'reserved')) h.admissionDrain.beginUnusedStopDrain();
    });
    try {
      const ensured = await h.invoke();
      expect(ensured).toMatchObject({ ok: true, terminalId: expect.any(String), reused: false });
      expect(h.admissionDrain.isQuiescing()).toBe(true);
      expect(h.provider.spawned).toHaveLength(1);
      expect(h.provider.spawned[0]!.params).toMatchObject({ file: '/managed/yarn', args: ['run', 'dev'], options: { cwd: h.root } });
      expect(h.provider.spawned[0]!.pty.writes).toEqual([]);
      const snapshot = h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation');
      expect(snapshot).toMatchObject({ state: 'running', domainRef: { kind: 'projectCommand', workspaceRefId: 'accepted', terminalId: expect.any(String) } });
      if (snapshot?.domainRef?.kind !== 'projectCommand' || !snapshot.domainRef.terminalId) throw new Error('actual terminal missing');
      expect(h.sessionManager.getCustody(snapshot.domainRef.terminalId)).toMatchObject({
        serverId: 'home', requesterAccountId: 'owner', machineId: 'machine', installationId: 'installation',
        workspaceRefId: 'accepted', projectKey: 'project', rootPath: `${h.root}/`,
      });
      h.provider.spawned[0]!.pty.emitBytes(Buffer.from('finite output', 'utf8'));
      expect(h.sessionManager.ensure({ terminalKey: 'competing', cwd: h.root })).toMatchObject({ ok: false, errorCode: 'terminal_busy' });
      h.provider.spawned[0]!.pty.exit(7);
      expect(await h.operationRuntime.runner.waitForTerminal({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({ state: 'failed', domainRef: { terminalId: snapshot.domainRef.terminalId } });
      const read = await h.sessionManager.readByteStream({ terminalId: snapshot.domainRef.terminalId, byteOffset: 0, maxBytes: 1000, maxFrames: 10 });
      expect(read).toMatchObject({ ok: true });
      if (!read.ok) throw new Error(read.code);
      const bytes = read.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
      expect(Buffer.concat(bytes.map(frame => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString('utf8')).toBe('finite output');
    } finally { unsubscribe(); await h.dispose(); }
  });

  it('does not turn an invocation waiver into setup consent or infer a Project from an enclosing cwd', async () => {
    const h = await finiteHarness({ waived: true, setup: true });
    try {
      // The mounted RPC waits for the real script attachment while D18 keeps
      // the original operation/reservation available to the human review UI.
      const review = new Promise<void>(resolve => {
        const unsubscribe = h.operationRuntime.store.subscribe(() => {
          if (h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')?.setupReview) {
            unsubscribe();
            resolve();
          }
        });
      });
      const pending = h.invoke();
      await review;
      expect(h.operationRuntime.store.get({ accountId: 'owner', machineId: 'machine' }, 'operation')).toMatchObject({
        state: 'accepted', setupReview: { code: 'project_setup_consent_required' },
      });
      expect(h.provider.spawned).toHaveLength(0);
      h.operationRuntime.runner.cancel({ accountId: 'owner', machineId: 'machine' }, 'operation');
      await expect(pending).resolves.toMatchObject({ ok: false, error: 'cancelled' });
      await mkdir(join(h.root, 'nested'));
      await expect(h.invoke(RPC_METHODS.DAEMON_TERMINAL_RESTART, join(h.root, 'nested'))).resolves.toMatchObject({ ok: false, error: 'project_workspace_unavailable' });
      expect(h.provider.spawned).toHaveLength(0);
      await expect(h.invoke(RPC_METHODS.DAEMON_TERMINAL_ENSURE, h.root, { ...h.ingress, machineAdmission: { ...h.ingress.machineAdmission!, actorAccountId: 'teammate' } })).resolves.toMatchObject({ ok: false, error: 'project_requester_credentials_unavailable' });
      h.retire();
      await expect(h.invoke()).resolves.toMatchObject({ ok: false, error: 'machine_admission_changed' });
      expect(h.provider.spawned).toHaveLength(0);
    } finally { await h.dispose(); }
  });

  it('retains the canonical default invocation approval on raw package-script RPC', async () => {
    const h = await finiteHarness();
    try {
      await expect(h.invoke()).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request', error: 'approvals_not_supported' });
      expect(h.provider.spawned).toHaveLength(0);
    } finally { await h.dispose(); }
  });
  it('refuses package-script execution without authenticated finite Project admission', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-script-terminal-')));
    const cwd = join(root, 'web');
    await mkdir(cwd);
    await writeFile(join(root, 'yarn.lock'), '');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'web; echo untrusted', scripts: { dev: 'vite', 'dev; echo injected': 'evil' } }));
    try {
      for (const platform of ['linux', 'win32'] as const) {
        const provider = new FakeInteractivePtyProvider();
        const env = { SHELL: '/bin/bash', ComSpec: 'cmd.exe' };
        const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env, platform,
          config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
            bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
        const registered = new Map<string, RpcHandler<unknown, unknown>>();
        registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler) } as unknown as RpcHandlerManager,
          deps: { env, platform, workingDirectory: root, sessionManager } });
        const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!;
        try {
          await expect(ensure({ terminalKey: 'script', cwd, launch: { kind: 'package_script', runTargetId: 'web; echo untrusted:dev' } })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
          await expect(ensure({ terminalKey: 'malicious', cwd, launch: { kind: 'package_script', runTargetId: 'web; echo untrusted:dev; echo injected' } })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
          expect(provider.spawned).toHaveLength(0);
        } finally { sessionManager.dispose(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('shares the lazy PTY owner with host finite execution and preserves interactive shell commands', async () => {
    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/bash' },
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: { registerHandler(method, handler) {
      handlers.set(method, async raw => Reflect.apply(handler, undefined, [raw]));
    } }, deps: { env: {}, sessionManager } });
    try {
      expect(registration.getSessionManager()).toBe(sessionManager);
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({ terminalKey: 'interactive', initialCommand: 'echo literal' })).resolves.toMatchObject({ ok: true });
      expect(provider.spawned[0]!.pty.writes).toEqual(['echo literal\n']);
      expect(registration.getSessionManager().list()).toHaveLength(1);
    } finally { registration.dispose(); }
  });
  it('lists existing terminals through the owner, rejects unknown input, and narrows restricted sessions', async () => {
    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/bash' },
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    sessionManager.ensure({ terminalKey: 'one', cwd: '/one', sessionId: 'session-one' });
    sessionManager.ensure({ terminalKey: 'two', cwd: '/two', sessionId: 'session-two' });
    let restart: RpcHandler<unknown, unknown> | undefined;
    const register = (requiredSessionId?: string) => {
      const registered = new Map<string, RpcHandler<unknown, unknown>>();
      registerMachineTerminalRpcHandlers({ rpcHandlerManager: {
        registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler as RpcHandler<unknown, unknown>),
      } as unknown as RpcHandlerManager, deps: { env: {}, sessionManager, requiredSessionId } });
      restart = registered.get(RPC_METHODS.DAEMON_TERMINAL_RESTART);
      return registered.get('daemon.terminal.list');
    };
    try {
      const list = register();
      expect(list).toBeDefined();
      await expect(list!({})).resolves.toEqual({ ok: true, terminals: sessionManager.list() });
      const originalTerminalId = sessionManager.list().find((terminal) => terminal.terminalKey === 'one')?.terminalId;
      await expect(restart!({ terminalKey: 'one' })).resolves.toMatchObject({ ok: true });
      expect(sessionManager.list().find((terminal) => terminal.terminalKey === 'one')?.terminalId).not.toBe(originalTerminalId);
      await expect(list!({})).resolves.toMatchObject({ ok: true, terminals: expect.arrayContaining([
        expect.objectContaining({ terminalKey: 'one', sessionId: 'session-one' }),
      ]) });
      await expect(list!({ sessionId: 'session-two' })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
      await expect(register('session-one')!({})).resolves.toEqual({ ok: true, terminals: sessionManager.list().filter((terminal) => terminal.sessionId === 'session-one') });
      expect(provider.spawned).toHaveLength(3);
    } finally { sessionManager.dispose(); }
  });

  it('returns an empty list before the PTY owner has been created', async () => {
    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    registerMachineTerminalRpcHandlers({ rpcHandlerManager: {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler as RpcHandler<unknown, unknown>),
    } as unknown as RpcHandlerManager, deps: { env: {} } });
    await expect(registered.get('daemon.terminal.list')!({})).resolves.toEqual({ ok: true, terminals: [] });
  });

  it('attributes restart after daemon state loss from the request and rejects a restricted sibling Session', async () => {
    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/bash' },
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const register = (requiredSessionId?: string) => {
      const registered = new Map<string, RpcHandler<unknown, unknown>>();
      registerMachineTerminalRpcHandlers({ rpcHandlerManager: {
        // The RPC registrar is the boundary; invoke its generic handler with wire input.
        registerHandler: (method, handler) => registered.set(method, async params => {
          const result: unknown = await Reflect.apply(handler, undefined, [params]);
          return result;
        }),
      }, deps: { env: {}, sessionManager, requiredSessionId } });
      return registered;
    };
    try {
      const handlers = register();
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!({ terminalKey: 'after-daemon-restart', sessionId: 'session-one' })).resolves.toMatchObject({ ok: true });
      await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({})).resolves.toMatchObject({ ok: true, terminals: [
        { terminalKey: 'after-daemon-restart', sessionId: 'session-one' },
      ] });
      const restricted = register('session-one');
      await expect(restricted.get(RPC_METHODS.DAEMON_TERMINAL_RESTART)!({ terminalKey: 'sibling', sessionId: 'session-two' })).resolves.toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
      expect(provider.spawned).toHaveLength(1);
    } finally { sessionManager.dispose(); }
  });
  it('fails closed when explicitly disabled', async () => {
    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '0' },
        workingDirectory: process.cwd(),
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_disabled',
      error: 'terminal_disabled',
    });
    await expect(registered.get(RPC_METHODS.DAEMON_TERMINAL_LIST)!({})).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_disabled',
      error: 'terminal_disabled',
    });
  });

  it('disposes the terminal owner when the machine RPC lifecycle closes', () => {
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: new FakeInteractivePtyProvider(), env: { SHELL: '/bin/bash' },
      platform: 'linux', stopProcessTree: async () => {},
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const registration = registerMachineTerminalRpcHandlers({
      rpcHandlerManager: { registerHandler() {} }, deps: { env: {}, sessionManager },
    });
    expect(sessionManager.ensure({ terminalKey: 'closing', cwd: process.cwd() })).toMatchObject({ ok: true });
    expect(sessionManager.list()).toHaveLength(1);
    registration.dispose();
    expect(sessionManager.list()).toEqual([]);
  });

  it('spawns a PTY session by default when cwd is allowed', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    const subDir = join(rootDir, 'subdir');
    await mkdir(rootDir, { recursive: true });
    await mkdir(subDir, { recursive: true });
    const realSubDir = await realpath(subDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: 'subdir', cols: 90, rows: 30 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realSubDir);
  });

  it('spawns a PTY session outside the default directory when unrestricted', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    const externalDir = join(suiteDir, 'external');
    await mkdir(rootDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });
    const realExternalDir = await realpath(externalDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    const result = await ensure!({ terminalKey: 'k', cwd: externalDir, cols: 90, rows: 30 });
    expect(result).toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned).toHaveLength(1);
    expect(await realpath(provider.spawned[0]?.options.cwd ?? '')).toBe(realExternalDir);
  });

  it('resolves a typed session-attach launch into PTY executable argv', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-attach-'));
    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    registerMachineTerminalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => registered.set(method, handler),
      } as unknown as RpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: suiteDir,
        sessionManager,
        resolveLaunch: () => ({ file: '/opt/happier/bin/happier', args: ['attach', 'session-1'] }),
      },
    });

    await expect(registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.({
      terminalKey: 'dialog-attach:session-1',
      cwd: suiteDir,
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    })).resolves.toEqual(expect.objectContaining({ ok: true, reused: false }));
    expect(provider.spawned[0]).toMatchObject({
      file: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
    });
  });

  it('rejects cwd outside the machine working directory', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: { HAPPIER_DAEMON_TERMINAL_ENABLED: '1' },
        workingDirectory: rootDir,
        accessPolicy: { kind: 'restrictedRoots', roots: [rootDir] },
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'k', cwd: '/etc', cols: 80, rows: 24 })).resolves.toEqual({
      ok: false,
      errorCode: 'terminal_cwd_denied',
      error: 'terminal_cwd_denied',
    });
  });

  it('canonicalizes home aliases through the injected environment before terminal authorization', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-home-'));
    const homeDir = join(suiteDir, 'home');
    const workspaceDir = join(homeDir, 'workspace', 'mixed');
    const siblingHomeDir = join(suiteDir, 'home2');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(siblingHomeDir, { recursive: true });
    const realWorkspaceDir = await realpath(workspaceDir);

    const provider = new FakePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });

    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: RpcHandler<unknown, unknown>) => registered.set(method, handler),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {
          HAPPIER_DAEMON_TERMINAL_ENABLED: '1',
          HOME: homeDir,
        },
        platform: 'linux',
        workingDirectory: homeDir,
        accessPolicy: { kind: 'restrictedRoots', roots: [homeDir] },
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    expect(ensure).toBeDefined();

    await expect(ensure!({ terminalKey: 'home-forward', cwd: '~/workspace/mixed', cols: 80, rows: 24 }))
      .resolves.toEqual(expect.objectContaining({ ok: true, reused: false }));
    await expect(ensure!({ terminalKey: 'home-backslash', cwd: '~\\workspace\\mixed', cols: 80, rows: 24 }))
      .resolves.toEqual(expect.objectContaining({ ok: true, reused: false }));
    await expect(ensure!({ terminalKey: 'home-sibling', cwd: '~\\..\\home2', cols: 80, rows: 24 }))
      .resolves.toEqual({
        ok: false,
        errorCode: 'terminal_cwd_denied',
        error: 'terminal_cwd_denied',
      });

    expect(provider.spawned).toHaveLength(2);
    await expect(Promise.all(provider.spawned.map(async ({ options }) => await realpath(options.cwd ?? ''))))
      .resolves.toEqual([realWorkspaceDir, realWorkspaceDir]);
  });

  it('accepts stream input through RPC and exposes resulting PTY output via byte-stream reads', async () => {
    const suiteDir = await mkdtemp(join(tmpdir(), 'happier-terminal-'));
    const rootDir = join(suiteDir, 'root');
    await mkdir(rootDir, { recursive: true });

    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 10,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 1_000_000,
        bufferMaxEvents: 1000,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: 16_384,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler as RpcHandler<unknown, unknown>),
    } as unknown as RpcHandlerManager;

    registerMachineTerminalRpcHandlers({
      rpcHandlerManager,
      deps: {
        env: {},
        workingDirectory: rootDir,
        sessionManager,
      },
    });

    const ensure = registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    const sendInput = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT);
    const readBytes = registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
    expect(ensure).toBeDefined();
    expect(sendInput).toBeDefined();
    expect(readBytes).toBeDefined();

    const ensured = await ensure!({ terminalKey: 'k-rpc-roundtrip', cwd: rootDir, cols: 80, rows: 24 });
    expect(ensured).toEqual(expect.objectContaining({ ok: true, reused: false }));
    if (!ensured || typeof ensured !== 'object' || !('ok' in ensured) || ensured.ok !== true || !('terminalId' in ensured)) {
      throw new Error('expected terminal ensure to succeed');
    }
    const terminalId = String(ensured.terminalId);

    await expect(sendInput!({
      terminalId,
      event: { t: 'text', text: 'printf terminal-marker' },
    })).resolves.toEqual({ ok: true });
    await expect(sendInput!({
      terminalId,
      event: { t: 'key', key: 'Enter', modifiers: [] },
    })).resolves.toEqual({ ok: true });

    expect(provider.spawned[0]?.pty.writes).toEqual(['printf terminal-marker', '\r']);

    const read = TerminalStreamReadResponseSchema.parse(await readBytes!({
      terminalId,
      byteOffset: 0,
      maxBytes: 4096,
      maxFrames: 8,
    }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected byte stream read to succeed');

    const byteFrames = read.frames.filter((frame): frame is TerminalStreamBytesFrame => frame.t === 'bytes');
    const decoded = Buffer.concat(byteFrames.map((frame) => Buffer.from(decodeTerminalStreamBytesFrame(frame)))).toString('utf8');
    expect(decoded).toContain('ran:printf terminal-marker');
  });

  it('caps omitted maxFrames responses including a gap frame', async () => {
    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({
      ptyProvider: provider,
      env: { SHELL: '/bin/bash' } as any,
      platform: 'linux',
      now: () => 0,
      config: {
        maxSessions: 1,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: TERMINAL_STREAM_MAX_FRAMES,
        bufferMaxEvents: TERMINAL_STREAM_MAX_FRAMES + 10,
        bufferRetentionMs: 10 * 60_000,
        urlParseBufferLimit: 32_768,
        maxWriteChunkBytes: TERMINAL_STREAM_MAX_FRAMES + 10,
        defaultCols: 80,
        defaultRows: 24,
      },
    });
    const registered = new Map<string, RpcHandler<unknown, unknown>>();

    try {
      registerMachineTerminalRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => registered.set(method, handler as RpcHandler<unknown, unknown>),
        } as unknown as RpcHandlerManager,
        deps: {
          env: {},
          workingDirectory: process.cwd(),
          sessionManager,
        },
      });

      const ensured = await registered.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.({
        terminalKey: 'frame-cap',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
      if (!ensured || typeof ensured !== 'object' || !('ok' in ensured) || ensured.ok !== true || !('terminalId' in ensured)) {
        throw new Error('expected terminal ensure to succeed');
      }
      const terminalId = String(ensured.terminalId);
      const pty = provider.spawned[0]?.pty;
      if (!pty) throw new Error('expected PTY to spawn');
      for (let index = 0; index < TERMINAL_STREAM_MAX_FRAMES + 1; index += 1) {
        pty.emitBytes(Buffer.from([index % 251]));
      }

      const response = TerminalStreamReadResponseSchema.parse(
        await registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)?.({ terminalId, byteOffset: 0 }),
      );
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error('expected byte stream read to succeed');
      expect(response.frames).toHaveLength(TERMINAL_STREAM_MAX_FRAMES);
      expect(response.frames[0]).toMatchObject({ t: 'gap', nextAvailableByteOffset: 1 });
      expect(response.nextByteOffset).toBe(TERMINAL_STREAM_MAX_FRAMES);
      expect(response.availableByteOffset).toBe(TERMINAL_STREAM_MAX_FRAMES + 1);
    } finally {
      sessionManager.dispose();
    }
  });

  it('preserves the real owner Windows legacy-only byte-stream projection', async () => {
    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: { ComSpec: 'cmd.exe' }, platform: 'win32', stopProcessTree: async () => {},
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({
      rpcHandlerManager: { registerHandler(method, handler) { registered.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { env: {}, sessionManager },
    });
    try {
      const ensured = sessionManager.ensure({ terminalKey: 'windows-legacy', cwd: process.cwd() });
      if (!ensured.ok) throw new Error(ensured.error);
      const read = TerminalStreamReadResponseSchema.parse(await registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES)!({
        terminalId: ensured.terminalId, byteOffset: 0,
      }));
      expect(read).toMatchObject({ ok: true, terminalId: ensured.terminalId, frames: [{ t: 'legacyOnly', provider: 'windows-conpty' }] });
    } finally { registration.dispose(); }
  });

  it('retains an actual OS resize refusal without falling back to terminal text input', async () => {
    const provider = new FakeInteractivePtyProvider();
    const sessionManager = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/bash' }, platform: 'linux', stopProcessTree: async () => {},
      config: { maxSessions: 10, idleTimeoutMs: 0, bufferMaxBytes: 1000, bufferMaxEvents: 10,
        bufferRetentionMs: 60_000, urlParseBufferLimit: 1000, maxWriteChunkBytes: 1000, defaultCols: 80, defaultRows: 24 } });
    const registered = new Map<string, RpcHandler<unknown, unknown>>();
    const registration = registerMachineTerminalRpcHandlers({
      rpcHandlerManager: { registerHandler(method, handler) { registered.set(method, handler as RpcHandler<unknown, unknown>); } },
      deps: { env: {}, sessionManager },
    });
    try {
      const ensured = sessionManager.ensure({ terminalKey: 'unsupported-resize', cwd: process.cwd() });
      if (!ensured.ok) throw new Error(ensured.error);
      provider.spawned[0]!.pty.resizeError = new Error('terminal_resize_unavailable');
      await expect(registered.get(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT)!({
        terminalId: ensured.terminalId, event: { t: 'resize', cols: 100, rows: 30 },
      })).resolves.toMatchObject({ ok: false, code: 'terminal_resize_unavailable' });
      expect(provider.spawned[0]!.pty.writes).toEqual([]);
    } finally { registration.dispose(); }
  });
});
