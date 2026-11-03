import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import type { PtyProcess } from '@/terminal/pty/provider';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('machine shell RPC custody', () => {
  it('opens a custodian machine shell without requiring a Project checkout and retains exact machine custody', async () => {
    await withTempDir('terminal-machine-shell-', async root => {
      // Only the OS PTY is substituted; RPC, admission, custody and output stay real.
      const events = new EventEmitter();
      const pty: PtyProcess = {
        pid: 0, write() {}, resize() {}, kill() {},
        onData(listener) { events.on('data', listener); return { dispose: () => { events.off('data', listener); } }; },
        onExit(listener) { events.on('exit', listener); return { dispose: () => { events.off('exit', listener); } }; },
      };
      const sessions = createTerminalPtySessionManager({ ptyProvider: { spawn: () => pty },
        config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux' });
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
      const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: rpc,
        deps: { serverId: 'home', env: {}, workingDirectory: root, sessionManager: sessions,
          accessPolicy: { kind: 'restrictedRoots', roots: [root] } } });
      let current = true;
      const rpcContext = { machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
        machineId: 'machine', installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => current };
      const input = { terminalKey: 'machine-shell:machine:opening', cwd: root };
      try {
        const opened = await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input, { rpcContext });
        expect(opened).toMatchObject({ ok: true, reused: false });
        const terminal = sessions.list()[0]!;
        expect(terminal.cwd).toBe(root);
        expect(sessions.getCustody(terminal.terminalId)).toEqual({ kind: 'machine', serverId: 'home',
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
          { terminalId: terminal.terminalId, cursor: 0 }, { rpcContext: foreignContext })).toMatchObject({ ok: false });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'guessed', rootPath: root } },
          { rpcContext })).toMatchObject({ ok: false });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, sessionId: 'guessed-session' }, { rpcContext })).toMatchObject({ ok: false });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, input,
          { rpcContext: { ...rpcContext, machineAdmission: { ...rpcContext.machineAdmission, role: 'use' } } }))
          .toMatchObject({ ok: false });
        current = false;
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
          { ...input, terminalKey: 'after-revoke' }, { rpcContext })).toMatchObject({ ok: false });
        expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
          { terminalId: terminal.terminalId, cursor: 0 }, { rpcContext })).toMatchObject({ ok: false });
        expect(sessions.list()).toHaveLength(1);
      } finally {
        events.emit('exit', { exitCode: 0 });
        registration.dispose();
      }
    });
  });
});
