import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { registerSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { spawnSessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { serveSessionTargetRelay, SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createDefaultPluginTerminalHostService } from '@/plugins/runtime/context/terminalHost';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/runtime/terminalMetadata';
import { createTerminalPtySessionManager } from './sessions';
import { createPtyTerminalHostAdapter } from './hostAdapter';
import { readDaemonTerminalPtyConfig } from './config';

const holderPath = process.env.HAPPIER_SESSION_HOLDER_TEST_EXECUTABLE ?? resolveSessionHolderExecutablePath();

describe.skipIf(process.platform !== 'linux' || !holderPath)('placed Session PTY launches', () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp('/tmp/session-pty-'); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each(['daemon', 'native-host', 'native-host-target-cwd'] as const)('routes a %s Session terminal through its target without local fallback', async mode => {
    const root = join(directory, `workspace-${mode}`);
    await mkdir(root);
    const lifetime = new AbortController();
    const socketPath = join(directory, `primary-${mode}.sock`);
    // The real holder and PTY run behind the provider's process/channel boundary.
    const target = {
      id: 'target:terminal', holderPath: holderPath!, helperPath: '/unused', socketDirectory: directory,
      exec: (command: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.once('error', reject);
        child.once('close', status => resolve({ status: status ?? 1, stdout, stderr }));
      }),
      openChannel(argv: readonly string[]) {
        const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
        const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
        child.once('close', () => channel.destroy());
        return channel;
      },
    };
    // A daemon machine terminal attaches beside the Session's held Agent; a native-host terminal Agent IS that held Agent.
    const agent = mode !== 'daemon' ? undefined
      : spawnSessionHolderChild({ executablePath: holderPath!, socketPath, command: '/bin/sleep', args: ['600'], cwd: root, target });
    if (agent) await new Promise<void>((resolve, reject) => { agent.once('spawn', resolve); agent.once('error', reject); });
    registerSessionTargetWorkspace({ sessionId: 'session-target-terminal', lifetime: lifetime.signal,
      primarySocketPath: socketPath, target, workspace: { hostRoot: '/host/session-workspace', targetRoot: root } });
    const localSpawn = vi.fn(() => { throw new Error('A placed Session must never spawn a local PTY'); });
    const localPrepare = vi.fn(async () => {});
    const manager = createTerminalPtySessionManager({ ptyProvider: { spawn: localSpawn, prepare: localPrepare },
      config: readDaemonTerminalPtyConfig({}).sessionManager, env: { SHELL: '/bin/sh', HAPPIER_TEST_HOST_SECRET: 'host-only' }, platform: 'linux' });
    const command = 'printf "TARGET:%s:%s\\n" "$PWD" "${HAPPIER_TEST_HOST_SECRET-unset}"; read answer; printf "INPUT:%s\\n" "$answer"';
    const workingDirectory = mode === 'native-host-target-cwd' ? root : '/host/session-workspace';
    try {
      if (mode !== 'daemon') {
        const relay = await serveSessionTargetRelay({ lifetime: lifetime.signal,
          socketPath: join(directory, `relay-${mode}.sock`), operations: target,
          readTrustedCallerPid: () => process.pid,
          observePeer: async () => ({ pid: process.pid, uid: process.getuid!() }) });
        await runAddedHostedSession({ workingDirectory: '/host/session-workspace', end: () => {}, environment: {
          [SESSION_TARGET_PLACEMENT_ENV_KEY]: JSON.stringify({ id: target.id, holderPath, socketDirectory: directory,
            relaySocketPath: relay.socketPath, primarySocketPath: socketPath,
            launch: { executables: { '/bin/sh': '/bin/sh' }, env: {}, workspace: { hostRoot: '/host/session-workspace', targetRoot: root } } }),
          HAPPIER_TEST_HOST_SECRET: 'host-only',
        } }, async () => {
          const service = createDefaultPluginTerminalHostService({ happyHomeDir: directory, hasCapability: () => true,
            currentTerminalMetadata: { startedBy: 'terminal', terminal: buildTerminalMetadataFromRuntimeFlags({
              mode: 'tmux', tmuxTarget: 'host-only:0.1', attachmentId: 'host-only-attachment',
            }) } });
          for (const preference of ['tmux', 'zellij', 'herdr'] as const) {
            expect(await service.resolve({ preference })).toMatchObject({ status: 'resolved', hostKind: 'pty' });
          }
          const adapter = createPtyTerminalHostAdapter({ ptyProvider: { spawn: localSpawn, prepare: localPrepare }, inputStabilityDelayMs: 0 });
          const handle = await adapter.createOrAttachHost({ sessionName: 'placed-native', workingDirectory,
            spawnArgv: ['/bin/sh', '-c', command], spawnEnv: {}, isolatedEnv: false });
          try {
            await expect.poll(async () => (await adapter.captureInputState?.(handle))?.currentInput).toContain(`TARGET:${root}:unset`);
            expect(localSpawn).not.toHaveBeenCalled();
            expect(localPrepare).not.toHaveBeenCalled();
            // The terminal Agent is the target's held primary Agent at the placement's primary address.
            await expect(stat(socketPath)).resolves.toBeTruthy();
          } finally { await adapter.dispose(handle); }
          await expect(adapter.createOrAttachHost({ sessionName: 'unmapped-agent', workingDirectory: '/host/session-workspace',
            spawnArgv: ['/host-only-agent'], spawnEnv: {}, isolatedEnv: true }))
            .rejects.toMatchObject({ code: 'agent_cli_target_unavailable' });
        });
        return;
      }
      const result = await manager.ensure({ terminalKey: 'target', sessionId: 'session-target-terminal', cwd: '/host/session-workspace',
        launchProcess: { file: '/bin/sh', args: ['-c', command] } });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.errorCode);
      const output = () => {
        const read = manager.read({ terminalId: result.terminalId, cursor: 0, maxBytes: 10000, maxEvents: 100 });
        return read.ok ? read.events.flatMap(event => event.t === 'data' ? [event.data] : []).join('') : '';
      };
      await expect.poll(output).toContain(`TARGET:${root}:unset`);
      expect(localSpawn).not.toHaveBeenCalled();
      expect(localPrepare).not.toHaveBeenCalled();
      expect(await manager.input({ terminalId: result.terminalId, data: 'placed-input\r' })).toMatchObject({ ok: true });
      await expect.poll(output).toContain('INPUT:placed-input');
      const finite = await manager.ensure({ terminalKey: 'finite-target', sessionId: 'session-target-terminal',
        cwd: '/host/session-workspace', holdUntilExit: true, launchProcess: { file: '/bin/sleep', args: ['600'] } });
      if (!finite.ok) throw new Error(finite.errorCode);
      expect(await manager.requestStop({ terminalId: finite.terminalId })).toEqual({ kind: 'unconfirmed' });
      await expect.poll(() => manager.read({ terminalId: finite.terminalId, cursor: 0, maxBytes: 10000, maxEvents: 100 }))
        .toMatchObject({ ok: true, events: expect.arrayContaining([
        { t: 'exit', exitCode: null, signal: constants.signals.SIGTERM },
      ]) });
    } finally {
      manager.dispose();
      lifetime.abort();
      await agent?.terminateGroup({ graceMs: 100 });
    }
  });
});
