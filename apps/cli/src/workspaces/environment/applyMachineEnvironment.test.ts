import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from '@/terminal/pty/provider';
import { applyMachineEnvironment } from './applyMachineEnvironment';

// Only native PTY/process-tree and installed-tool IO are substituted. The
// terminal/output lifetime, native environment and Saved Secret owners are real.
class SetupPty implements PtyProcess {
  readonly pid = 23456;
  readonly ownedProcessGroupId = 23456;
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  write() { throw new Error('Setup is not interactive'); }
  resize() {}
  kill() {}
  onData() { return { dispose() {} }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode, signal: 0 }); }
}

describe('applyMachineEnvironment', () => {
  const roots: string[] = [];
  const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
  afterEach(async () => {
    managers.splice(0).forEach(manager => manager.dispose());
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function fixture(autoExit = false) {
    const home = await mkdtemp(join(tmpdir(), 'happier-machine-setup-'));
    roots.push(home);
    const spawned: Array<{ launch: PtySpawnParams; pty: SetupPty }> = [];
    const provider: PtyProvider = { spawn(launch) { const pty = new SetupPty(); spawned.push({ launch, pty });
      if (autoExit) queueMicrotask(() => pty.exit(0));
      return pty; } };
    let stopped = 0;
    const terminalSessions = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/bash' },
      probeProcessGroup: () => 'absent', stopProcessTree: async () => { stopped++; },
      config: { maxSessions: 10, idleTimeoutMs: 60000, bufferMaxBytes: 100000, bufferMaxEvents: 1000,
        bufferRetentionMs: 600000, urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 },
    });
    managers.push(terminalSessions);
    const updates: ActionOperationOwnerUpdate[] = [];
    const controller = new AbortController();
    const nativeRequests: unknown[] = [];
    const input = {
      homeId: 'home', machineId: 'guest', preset: { id: 'preset', revision: 4 }, requesterAccountId: 'owner', userHomeDirectory: home,
      environment: { toolchain: { adapterId: 'mise', config: '[env]\nREMOVE = false\n' }, setupScript: 'echo setup',
        secretRefs: { v: 1 as const, bindings: { SETUP_SECRET: { ref: 'saved' } } } },
      terminalSessions, platform: 'linux' as const, hostEnvironment: { SHELL: '/bin/bash', PATH: '/host', REMOVE: 'remove' },
      isCurrent: async () => true,
      secretEnvironment: { accountSettings: { secrets: [{ id: 'saved', name: 'Setup', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true as const, value: 'private-value' }, createdAt: 1, updatedAt: 1 }] }, settingsSecretsReadKeys: [] },
      environmentIo: {
        resolveTool: async () => ({ executablePath: '/tools/runtime', args: ['mise'], version: '2026.10.4' }),
        run: async (request: unknown) => { nativeRequests.push(request); return { exitCode: 0, stdout: 'PATH=/native\0' }; },
      },
      operation: { actionRequestId: 'setup-operation', signal: controller.signal,
        operationProgress: { update() {} }, operationOwnerUpdate: { update: (update: ActionOperationOwnerUpdate) => updates.push(update) } },
    };
    return { home, spawned, updates, input, nativeRequests, controller, stopped: () => stopped };
  }
  it('refuses config and process effects when installed custody changes during native tool resolution', async () => {
    const f = await fixture(true);
    let current = true;
    const result = await applyMachineEnvironment({ ...f.input, isCurrent: async () => current,
      environmentIo: { ...f.input.environmentIo, resolveTool: async () => {
        current = false;
        return { executablePath: '/tools/runtime', args: ['mise'], version: '2026.10.4' };
      } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'machine_admission_changed' });
    await expect(readFile(join(f.home, '.config/mise/config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.spawned).toHaveLength(0);
    expect(f.nativeRequests).toHaveLength(0);
  });
  it('writes native global config, installs first, then injects secrets only in the setup process', async () => {
    const f = await fixture();
    const work = applyMachineEnvironment(f.input);
    await expect.poll(() => f.spawned.length).toBe(1);
    expect(await readFile(join(f.home, '.config/mise/config.toml'), 'utf8')).toBe(f.input.environment.toolchain.config);
    expect(f.spawned[0]!.launch).toMatchObject({ file: '/tools/runtime', args: ['mise', 'install'], options: { cwd: f.home } });
    expect(f.spawned[0]!.launch.options.env).not.toHaveProperty('SETUP_SECRET');
    f.spawned[0]!.pty.exit(0);
    await expect.poll(() => f.spawned.length).toBe(2);
    expect(f.nativeRequests).toEqual([expect.objectContaining({ command: '/tools/runtime', args: ['mise', 'exec', '--', '/usr/bin/env', '-0'] })]);
    expect(f.spawned[1]!.launch).toMatchObject({ file: '/bin/bash', args: ['-c', 'echo setup'], options: { env: { PATH: '/native', SETUP_SECRET: 'private-value' } } });
    expect(f.spawned[1]!.launch.options.env).not.toHaveProperty('REMOVE');
    f.spawned[1]!.pty.exit(0);
    expect(await work).toMatchObject({ ok: true, result: { operationId: 'setup-operation', terminalId: expect.any(String) } });
    expect(f.updates.at(-1)?.domainRef).toMatchObject({ kind: 'machineEnvironment', terminals: { install: expect.any(String), setup: expect.any(String) }, terminalId: expect.any(String) });
    expect(JSON.stringify(f.updates)).not.toContain('private-value');
  });
  it('keeps cancellation pending until actual process exit and never starts the setup script', async () => {
    const f = await fixture();
    let settled = false;
    const work = applyMachineEnvironment(f.input).finally(() => { settled = true; });
    await expect.poll(() => f.spawned.length).toBe(1);
    f.controller.abort();
    await expect.poll(() => f.stopped()).toBe(1);
    expect(settled).toBe(false);
    f.spawned[0]!.pty.exit(0);
    expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.spawned).toHaveLength(1);
  });
  it('stops on containing transport cancellation without confusing it with the owned Stop signal', async () => {
    const f = await fixture();
    const external = new AbortController();
    const work = applyMachineEnvironment({ ...f.input, signal: external.signal,
      operation: { ...f.input.operation, operationCancellation: { onRequest() { return () => {}; } } } });
    await expect.poll(() => f.spawned.length).toBe(1);
    try {
      external.abort();
      await expect.poll(() => f.stopped()).toBe(1);
      expect(f.input.operation.signal.aborted).toBe(false);
      f.spawned[0]!.pty.exit(0);
      expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(f.spawned).toHaveLength(1);
    } finally { f.controller.abort(); f.spawned[0]!.pty.exit(0); await work; }
  });
  it('refuses an unsupported global adapter before writing files or executing commands', async () => {
    const f = await fixture();
    expect(await applyMachineEnvironment({ ...f.input, environment: { toolchain: { adapterId: 'pixi', config: 'unsupported' } } }))
      .toMatchObject({ ok: false, errorCode: 'native_adapter_not_characterized' });
    expect(f.spawned).toHaveLength(0);
    await expect(readFile(join(f.home, '.config/mise/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('honors the native global path overrides and stops after a failed install', async () => {
    const f = await fixture();
    const custom = join(f.home, 'custom config', 'chosen.toml');
    const work = applyMachineEnvironment({ ...f.input, hostEnvironment: { ...f.input.hostEnvironment,
      MISE_GLOBAL_CONFIG_FILE: custom, MISE_CONFIG_DIR: join(f.home, 'ignored'), XDG_CONFIG_HOME: join(f.home, 'also-ignored') } });
    await expect.poll(() => f.spawned.length).toBe(1);
    expect(await readFile(custom, 'utf8')).toBe(f.input.environment.toolchain.config);
    expect(f.spawned[0]!.launch.options.env).toMatchObject({ MISE_OVERRIDE_CONFIG_FILENAMES: custom });
    f.spawned[0]!.pty.exit(5);
    expect(await work).toMatchObject({ ok: false, errorCode: 'machine_environment_install_failed' });
    expect(f.spawned).toHaveLength(1);
    expect(f.nativeRequests).toHaveLength(0);
  });
  it('does not run setup or expose private diagnostics after native environment failure', async () => {
    const f = await fixture();
    const work = applyMachineEnvironment({ ...f.input, environmentIo: { ...f.input.environmentIo,
      run: async () => ({ exitCode: 42, stdout: 'private-native-diagnostic' }) } });
    await expect.poll(() => f.spawned.length).toBe(1);
    f.spawned[0]!.pty.exit(0);
    const result = await work;
    expect(result).toMatchObject({ ok: false, errorCode: 'native_environment_failed' });
    expect(JSON.stringify(result)).not.toContain('private-native-diagnostic');
    expect(f.spawned).toHaveLength(1);
  });
  it('waits for cancelled native environment IO to settle before returning without setup', async () => {
    const f = await fixture();
    let release!: () => void;
    let nativeEntered = false;
    const nativeExit = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const work = applyMachineEnvironment({ ...f.input, environmentIo: { ...f.input.environmentIo,
      run: async () => { nativeEntered = true; await nativeExit; return { exitCode: 0, stdout: 'PATH=/native\0' }; } } }).finally(() => { settled = true; });
    await expect.poll(() => f.spawned.length).toBe(1);
    f.spawned[0]!.pty.exit(0);
    await expect.poll(() => nativeEntered).toBe(true);
    f.controller.abort();
    expect(settled).toBe(false);
    release();
    expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.spawned).toHaveLength(1);
  });
  it.each([
    { platform: 'darwin' as const, shellEnv: { SHELL: '/bin/zsh' }, file: '/bin/zsh', args: ['-c', 'echo setup'] },
    { platform: 'win32' as const, shellEnv: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'echo setup'] },
  ])('uses the canonical script-only shell on $platform without a native toolchain', async ({ platform, shellEnv, file, args }) => {
    const f = await fixture();
    const work = applyMachineEnvironment({ ...f.input, platform, hostEnvironment: { ...f.input.hostEnvironment, ...shellEnv },
      environment: { setupScript: 'echo setup', secretRefs: f.input.environment.secretRefs } });
    await expect.poll(() => f.spawned.length).toBe(1);
    expect(f.spawned[0]!.launch).toMatchObject({ file, args, options: { cwd: f.home, env: { PATH: '/host', REMOVE: 'remove', SETUP_SECRET: 'private-value' } } });
    f.spawned[0]!.pty.exit(0);
    expect(await work).toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
    expect(f.nativeRequests).toHaveLength(0);
    await expect(readFile(join(f.home, '.config/mise/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
