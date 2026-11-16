import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { authorizeMachineRpcRequest } from './machineRpcAuthorization';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import type { PtyProcess } from '@/terminal/pty/provider';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { updateSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';

describe('machine shell RPC custody', () => {
  it('keeps native machine login outside Session and Project custody for every launch entry', async () => {
    await withTempDir('terminal-login-scope-', async root => {
      const handlers = new Map<string, import('../rpc/types').RpcHandler>();
      const registration = registerMachineTerminalRpcHandlers({
        rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
        deps: { serverId: 'home', resolveHostHomeServerIdentityId: async () => 'home',
          env: {}, workingDirectory: root, accessPolicy: { kind: 'restrictedRoots', roots: [root] } },
      });
      try {
        for (const role of ['use', 'manage'] as const) {
          const context = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
            verifyMachineAdmissionCurrent: async () => true,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
              installationId: 'installation', encryptionMode: 'plain' as const, role } };
          for (const method of [RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.DAEMON_TERMINAL_RESTART]) {
            for (const target of [{ sessionId: 'own-session' },
              { workspace: { serverId: 'home', workspaceId: 'project', machineId: 'machine', rootPath: root } }]) {
              expect(await handlers.get(method)!({ terminalKey: 'native-login', launch: { kind: 'agent_login',
                agentId: 'happier.scm.forge.github/gh' }, ...target }, context))
                .toMatchObject({ ok: false, errorCode: 'terminal_invalid_request' });
            }
          }
        }
      } finally { registration.dispose(); }
    });
  });

  it.each(['session', 'project'] as const)('verifies retained %s terminal input once at installed Machine ingress', async kind => {
    const f = await createInstalledFilesystemMachineFixture();
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [f.serverId]: {
      id: f.serverId, name: 'Terminal Home', serverUrl: f.serverHttpBaseUrl,
      webappUrl: f.serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: f.homeServerIdentityId,
        canonicalServerUrl: f.serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: f.serverHttpBaseUrl }] }),
    } } }));
    await writeStoredCredentialsForServerId(f.serverId, f.bootstrap.credentials);
    const root = f.directory;
    const events = new EventEmitter();
    const writes: string[] = [];
    const pty: PtyProcess = {
      pid: 0, write(data) { writes.push(data); }, resize() {}, kill() {},
      onData(listener) { events.on('data', listener); return { dispose: () => { events.off('data', listener); } }; },
      onExit(listener) { events.on('exit', listener); return { dispose: () => { events.off('exit', listener); } }; },
    };
    const sessions = createTerminalPtySessionManager({ ptyProvider: { spawn: () => pty },
      config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux' });
    const workspace = { id: 'retained-workspace', serverId: f.homeServerIdentityId, machineId: f.machineId,
      rootPath: root, createdAtMs: 0, label: null, lastOpenedAtMs: null };
    const rows = [createPlainProjectAccountRefRow(workspace)];
    const get = vi.mocked(axios.get).getMockImplementation();
    const post = vi.mocked(axios.post).getMockImplementation();
    if (!get || !post) throw new Error('Installed Home HTTP boundary is unavailable');
    let homeRequests = 0;
    const homeReadPaths: string[] = [];
    const homeWritePaths: string[] = [];
    // Only authenticated Home HTTP and the native PTY are substituted. The
    // installed runtime, ingress, Session/Project readers and custody stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      homeRequests++;
      homeReadPaths.push(new URL(String(url)).pathname);
      if (String(url).endsWith('/v2/sessions/retained-session')) return { status: 200, data: { session: {
        ...createSessionNotificationContextFixture('retained-session'), encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId: f.machineId, path: root }),
      } } };
      return get(url, options);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      homeRequests++;
      homeWritePaths.push(new URL(String(url)).pathname);
      if (String(url).endsWith('/list') || String(url).endsWith('/read')) {
        return projectAccountRowsReadHttpResponse(rows, String(url), body);
      }
      return post(url, body, options);
    });
    const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: f.rpcHandlerManager,
      deps: { serverId: f.serverId, resolveHostHomeServerIdentityId: async () => f.homeServerIdentityId,
        env: {}, workingDirectory: root, sessionManager: sessions,
        accessPolicy: { kind: 'restrictedRoots', roots: [root] },
        accountReadRuntime: ingress => f.machine.resolveOwnSessionRuntime(ingress) } });
    try {
      const base = { serverId: f.serverId, requesterAccountId: 'requester', machineId: f.machineId,
        installationId: f.installation.installationId, rootPath: root };
      // Seed through the real native owner, as after a successful Session/Project
      // launch; each subsequent keystroke traverses the public installed receiver.
      const opened = await sessions.ensure({ terminalKey: `retained-${kind}`, cwd: root, requesterAccountId: 'requester',
        ...(kind === 'session' ? { sessionId: 'retained-session', custody: { ...base, kind: 'session', sessionId: 'retained-session' } }
          : { custody: { ...base, workspaceRefId: workspace.id, projectKey: workspace.id } }) });
      expect(opened).toMatchObject({ ok: true });
      if (!opened.ok) throw new Error('Native terminal birth failed');
      const before = f.admissionChecks();
      const beforeHomeRequests = homeRequests;
      const beforeHomeReads = homeReadPaths.length;
      const beforeHomeWrites = homeWritePaths.length;
      for (let index = 0; index < 10; index++) {
        const response = await f.invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
          { terminalId: opened.terminalId, event: { t: 'text', text: 'x' } });
        const refusal = response && typeof response === 'object'
          ? { code: Reflect.get(response, 'code'), errorCode: Reflect.get(response, 'errorCode') } : undefined;
        expect(response, JSON.stringify({ kind, inputIndex: index, refusal,
          homeRequests: homeRequests - beforeHomeRequests, homeReadPaths, homeWritePaths })).toMatchObject({ ok: true });
      }
      expect(writes.join('')).toBe('x'.repeat(10));
      expect(f.admissionChecks() - before).toBe(10);
      const inputReads = homeReadPaths.slice(beforeHomeReads);
      const inputWrites = homeWritePaths.slice(beforeHomeWrites);
      expect(inputWrites).toEqual(Array.from({ length: 10 }, () => `/v1/machines/${f.machineId}/admission/verify`));
      // The installed receiver captures its authenticated custodian Profile
      // once via ApiMachineClient.getAccountId's lifetime promise. Retained
      // keystrokes need no private Session or Project snapshots thereafter.
      expect(inputReads.filter(path => path !== '/v1/account/profile')).toEqual([]);
      expect(inputReads.length).toBeLessThanOrEqual(1);
      expect(homeRequests - beforeHomeRequests).toBe(10 + inputReads.length);
      f.retire();
      await expect(f.invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
        { terminalId: opened.terminalId, event: { t: 'text', text: 'revoked' } })).resolves.not.toMatchObject({ ok: true });
      expect(writes.join('')).toBe('x'.repeat(10));
    } finally { events.emit('exit', { exitCode: 0 }); registration.dispose(); }
  });
  it('verifies each admitted terminal input once without per-keystroke Home rechecks', async () => {
    await withTempDir('terminal-admission-cost-', async root => {
      const events = new EventEmitter();
      const writes: string[] = [];
      const pty: PtyProcess = {
        pid: 0, write(data) { writes.push(data); }, resize() {}, kill() {},
        onData(listener) { events.on('data', listener); return { dispose: () => { events.off('data', listener); } }; },
        onExit(listener) { events.on('exit', listener); return { dispose: () => { events.off('exit', listener); } }; },
      };
      const sessions = createTerminalPtySessionManager({ ptyProvider: { spawn: () => pty },
        config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux' });
      let current = true;
      let checks = 0;
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
          machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
          resolveHomeServerIdentityId: async () => 'home',
          verifyMachineAdmission: async () => { checks++; return current; },
        }) });
      const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: rpc,
        deps: { serverId: 'home', resolveHostHomeServerIdentityId: async () => 'home', env: {}, workingDirectory: root,
          sessionManager: sessions, accessPolicy: { kind: 'restrictedRoots', roots: [root] } } });
      const invoke = (method: string, params: unknown, actorAccountId = 'owner') => rpc.handleRequest({
        method: `machine:${method}`, params, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      });
      try {
        await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'input-cost', cwd: root }))
          .resolves.toMatchObject({ ok: true });
        const terminalId = sessions.list()[0]!.terminalId;
        const before = checks;
        for (let index = 0; index < 10; index++) {
          await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId, event: { t: 'text', text: 'x' } }))
            .resolves.toMatchObject({ ok: true });
        }
        expect(writes.join('')).toBe('x'.repeat(10));
        expect(checks - before).toBe(10);
        await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId, event: { t: 'text', text: 'member' } }, 'member'))
          .resolves.toMatchObject({ ok: false, code: 'terminal_forbidden' });
        current = false;
        await expect(invoke(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId, event: { t: 'text', text: 'revoked' } }))
          .resolves.not.toMatchObject({ ok: true });
        expect(writes.join('')).toBe('x'.repeat(10));
      } finally { events.emit('exit', { exitCode: 0 }); registration.dispose(); }
    });
  });
  it('opens a custodian machine shell without requiring a Project checkout and retains exact machine custody', async () => {
    await withTempDir('terminal-machine-shell-', async root => {
      // Only the OS PTY is substituted; RPC, admission, custody and output stay real.
      const events = new EventEmitter();
      const writes: string[] = [];
      const pty: PtyProcess = {
        pid: 0, write(data) { writes.push(data); }, resize() {}, kill() {},
        onData(listener) { events.on('data', listener); return { dispose: () => { events.off('data', listener); } }; },
        onExit(listener) { events.on('exit', listener); return { dispose: () => { events.off('exit', listener); } }; },
      };
      const sessions = createTerminalPtySessionManager({ ptyProvider: { spawn: () => pty },
        config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux' });
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain',
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
          machineId: 'machine', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'installation',
          resolveHomeServerIdentityId: async () => 'home', verifyMachineAdmission: async () => true,
        }) });
      const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: rpc,
        deps: { serverId: 'home', resolveHostHomeServerIdentityId: async () => 'home', env: {}, workingDirectory: root, sessionManager: sessions,
          accessPolicy: { kind: 'restrictedRoots', roots: [root] } } });
      const rpcContext = { callerAuthority: 'present_user' as const, machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
        machineId: 'machine', installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => true };
      const input = { terminalKey: 'machine-shell:machine:opening', cwd: root };
      try {
        const opened = await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input, { rpcContext });
        expect(opened).toMatchObject({ ok: true, reused: false });
        const terminal = sessions.list()[0]!;
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input,
          { rpcContext: { ...rpcContext, callerAuthority: 'account_automation' } }))
          .toMatchObject({ ok: true, reused: true, terminalId: terminal.terminalId });
        expect(terminal.cwd).toBe(root);
        expect(sessions.getCustody(terminal.terminalId)).toEqual({ kind: 'machine', serverId: 'home', homeServerIdentityId: 'home',
          requesterAccountId: 'owner', machineId: 'machine', installationId: 'installation', rootPath: root });
        events.emit('data', 'machine shell output');
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
          { terminalId: terminal.terminalId, cursor: 0 }, { rpcContext }))
          .toMatchObject({ ok: true, events: [expect.objectContaining({ data: 'machine shell output' })] });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input, { rpcContext }))
          .toMatchObject({ ok: true, reused: true, terminalId: terminal.terminalId });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, cwd: dirname(root) }, { rpcContext }))
          .toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
        const foreignContext = { ...rpcContext, machineAdmission: { ...rpcContext.machineAdmission, actorAccountId: 'recipient', role: 'use' as const } };
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input, { rpcContext: foreignContext }))
          .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
          { terminalId: terminal.terminalId, cursor: 0 }, { rpcContext: foreignContext }))
          .toMatchObject({ ok: false, errorCode: 'terminal_forbidden' });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'guessed', rootPath: root } },
          { rpcContext })).toMatchObject({ ok: false });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, sessionId: 'guessed-session' }, { rpcContext })).toMatchObject({ ok: false });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input,
          { rpcContext: { ...rpcContext, machineAdmission: { ...rpcContext.machineAdmission, role: 'use' } } }))
          .toMatchObject({ ok: false });
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, terminalKey: 'cancelled-open' }, { rpcContext, signal: cancelled.signal }))
          .rejects.toMatchObject({ name: 'AbortError' });
        await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
          { terminalId: terminal.terminalId, event: { t: 'text', text: 'cancelled' } }, { rpcContext, signal: cancelled.signal }))
          .rejects.toMatchObject({ name: 'AbortError' });
        expect(sessions.list()).toHaveLength(1);
        expect(writes).toEqual([]);
      } finally {
        events.emit('exit', { exitCode: 0 });
        registration.dispose();
      }
    });
  });
});
