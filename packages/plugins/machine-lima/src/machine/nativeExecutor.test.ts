import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { changeLimaPower, execLimaGuest, inspectLimaInstance, openLimaGuestChannel, putLimaGuestFile } from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import { createLimaSdkExecutor } from './nativeExecutor.js';

const executable: ManagedExecutableRef = { kind: 'managedDependency', id: { pluginId: 'happier.machine.lima', localId: 'lima-cli' } };
const testDirectory = mkdtempSync(join(tmpdir(), 'happier-lima-native-test-'));
afterAll(() => rmSync(testDirectory, { recursive: true, force: true }));
const identity = { instance: 'happier-test', store: join(testDirectory, 'store') };
const native = { name: identity.instance, dir: `${identity.store}/${identity.instance}`, status: 'Running' };

function success(stdout = new Uint8Array()): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

// The native filesystem store contract is POSIX; Lima supports Darwin and Linux hosts.
describe.skipIf(process.platform === 'win32')('public Lima process transport', () => {
  it.each([
    { ssh: undefined, expected: 'ssh -o StreamLocalBindUnlink=yes' },
    { ssh: '', expected: 'ssh -o StreamLocalBindUnlink=yes' },
    { ssh: ' \t ', expected: 'ssh -o StreamLocalBindUnlink=yes' },
    { ssh: "'/opt/custom ssh/bin/ssh' -i '/private/key with spaces' -o ProxyCommand='relay $HOST *.example'",
      expected: "'/opt/custom ssh/bin/ssh' -i '/private/key with spaces' -o ProxyCommand='relay $HOST *.example' -o StreamLocalBindUnlink=yes" },
    { ssh: '  custom-ssh -o ProxyCommand="relay $HOST"  ', expected: '  custom-ssh -o ProxyCommand="relay $HOST"   -o StreamLocalBindUnlink=yes' },
    // OpenSSH uses the first value. A deliberate custom refusal remains authoritative.
    { ssh: 'custom-ssh -oStreamLocalBindUnlink=no', expected: 'custom-ssh -oStreamLocalBindUnlink=no -o StreamLocalBindUnlink=yes' },
  ])('allows native socket rebinding without replacing the configured SSH command: $ssh', async ({ ssh, expected }) => {
    vi.stubEnv('SSH', ssh);
    try {
      let running = false;
      const exec: Pick<ExecService, 'run'> = { run: async request => {
        expect(request.cwd).toBe(identity.store);
        expect(request.env).toEqual({ LIMA_HOME: '.', SSH: expected });
        if (request.args?.[0] === 'restart') running = true;
        return success(new TextEncoder().encode(JSON.stringify({ ...native, status: running ? 'Running' : 'Stopped' })));
      } };
      const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
      await expect(changeLimaPower({ executor, ...identity, intent: 'start' }))
        .resolves.toEqual({ changed: true, status: 'Running' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('opens the stream channel as one interactive guest shell process carrying the invocation channel', async () => {
    const spawned: unknown[] = [];
    const handle = { kind: 'channel-handle' };
    const exec: Pick<ExecService, 'run' | 'spawn'> = {
      run: async () => success(new TextEncoder().encode(JSON.stringify(native))),
      spawn: async (request, options) => {
        spawned.push({ args: request.args, cwd: request.cwd, env: request.env, outputDelivery: options?.outputDelivery });
        return handle as never;
      },
    };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    await expect(openLimaGuestChannel({ executor, ...identity, argv: ['hshim', 'attach', '--socket', '/s'] })).resolves.toBe(handle);
    expect(spawned).toEqual([{ args: ['shell', '--workdir=/', identity.instance, '--', 'hshim', 'attach', '--socket', '/s'],
      cwd: identity.store, env: { LIMA_HOME: '.', SSH: 'ssh -o StreamLocalBindUnlink=yes' }, outputDelivery: 'invocation' }]);
  });

  it('opens no channel to a guest that is not running', async () => {
    let spawned = 0;
    const exec: Pick<ExecService, 'run' | 'spawn'> = {
      run: async () => success(new TextEncoder().encode(JSON.stringify({ ...native, status: 'Stopped' }))),
      spawn: async () => { spawned += 1; return {} as never; },
    };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    await expect(openLimaGuestChannel({ executor, ...identity, argv: ['x'] })).rejects.toMatchObject({ code: 'LIMA_GUEST_UNAVAILABLE' });
    expect(spawned).toBe(0);
  });

  it('uses a short relative native home inside the exact missing long persistent store', async () => {
    const store = join(testDirectory, 'long-selected-persistent-store-'.repeat(5));
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      expect(request.cwd).toBe(store);
      expect(request.env).toEqual({ LIMA_HOME: '.', SSH: 'ssh -o StreamLocalBindUnlink=yes' });
      const directory = await stat(store);
      expect(directory.isDirectory()).toBe(true);
      expect(directory.mode & 0o777).toBe(0o700);
      return success(new TextEncoder().encode(JSON.stringify({ ...native, dir: identity.instance })));
    } };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    await expect(inspectLimaInstance({ executor, ...identity, store }))
      .resolves.toMatchObject({ name: identity.instance, dir: `${store}/${identity.instance}` });
  });

  it.each(['../other/happier-test', '/another-store/happier-test'])('refuses a relative observation escaping the selected store: %s', async dir => {
    const result = { exitCode: 0, out: JSON.stringify({ ...native, dir }) };
    await expect(inspectLimaInstance({ executor: { capture: async () => result, run: async () => result }, ...identity }))
      .rejects.toMatchObject({ code: 'LIMA_IDENTITY_MISMATCH' });
  });

  it('uses the resolved native executable independently of the internal command label', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      expect(request.executable).toEqual(executable);
      expect(request.args).toEqual(['--version']);
      return success(new TextEncoder().encode('limactl version 2.1.0'));
    } };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    await expect(executor.capture('/native/limactl', ['--version'])).resolves.toMatchObject({ exitCode: 0, out: 'limactl version 2.1.0' });
  });

  it.each(['start', 'stop'] as const)('uses the native daemon lifetime for retained power %s', async intent => {
    let running = intent === 'stop';
    // Replace only public process IO; the shared power owner chooses the real
    // retained-instance command and the SDK executor supplies its lifetime.
    const exec: Pick<ExecService, 'run'> = { run: async (request, options) => {
      if (request.args?.[0] === 'list') {
        return success(new TextEncoder().encode(JSON.stringify({ ...native, status: running ? 'Running' : 'Stopped' })));
      }
      expect(request.args).toEqual([intent === 'start' ? 'restart' : 'stop', identity.instance]);
      expect(options?.descendantDisposition).toBe(intent === 'start' ? 'preserve-on-success' : undefined);
      running = intent === 'start';
      return success();
    } };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    await expect(changeLimaPower({ executor, ...identity, intent }))
      .resolves.toEqual({ changed: true, status: intent === 'start' ? 'Running' : 'Stopped' });
  });

  it('hands explicit native start descendants to Lima while stop, delete and guest IO remain supervised', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async (request, options) => {
      expect(options?.descendantDisposition).toBe(request.args?.[0] === 'start' ? 'preserve-on-success' : undefined);
      return success();
    } };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    for (const verb of ['start', 'stop', 'delete', 'create', 'shell', 'list']) {
      await executor.capture('limactl', [verb, identity.instance]);
    }
  });

  it('puts binary private payload only on stdin at the declared process boundary', async () => {
    const payload = new Uint8Array([0, 255, 10, 34, 36]);
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async (request, options) => {
      requests.push(request);
      expect(options?.outputDelivery).toBe(request.args?.[0] === 'shell' ? 'invocation' : undefined);
      return request.args?.[0] === 'list' ? success(new TextEncoder().encode(JSON.stringify(native))) : success();
    } };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    expect(await putLimaGuestFile({ executor, ...identity, guestPath: '/tmp/private-enrollment', bytes: payload })).toEqual({ kind: 'written' });
    const shell = requests.find((request) => request.args?.[0] === 'shell');
    expect(shell?.stdin).toEqual(payload);
    expect(shell?.env).toEqual({ LIMA_HOME: '.', SSH: 'ssh -o StreamLocalBindUnlink=yes' });
    expect(shell?.cwd).toBe(identity.store);
    expect(shell?.args?.slice(-2)).toEqual(['/tmp/private-enrollment', '0600']);
    expect(requests.filter((request) => request.stdin !== undefined)).toEqual([shell]);
  });

  it('preserves cancellation and binary output rather than treating an exited command as success', async () => {
    const process: PluginProcessResult = { ...success(new Uint8Array([255, 0])),
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' } }, stdoutTruncated: true };
    const exec: Pick<ExecService, 'run'> = { run: async (request) => request.args?.[0] === 'list'
      ? success(new TextEncoder().encode(JSON.stringify(native))) : process };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    const result = await execLimaGuest({ executor, ...identity, argv: ['printf', 'binary'] });
    expect(result.exitCode).toBeNull();
    expect(result.process).toBe(process);
  });

  it('does not decode a truncated observation as confirmed native absence', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async () => ({ ...success(), stdoutTruncated: true }) };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    await expect(executor.capture('limactl', ['list', '--all-fields', '--format=json', identity.instance]))
      .rejects.toMatchObject({ code: 'LIMA_INSPECT_UNAVAILABLE' });
  });

  it.each([
    { command: 'create', code: 'lima_create_failed', cancelled: false },
    { command: 'create', code: 'lima_create_failed', cancelled: true },
    { command: 'restart', code: 'lima_start_failed', cancelled: false },
    { command: 'restart', code: 'lima_start_failed', cancelled: true },
    { command: 'edit', code: 'lima_resize_failed', cancelled: false },
    { command: 'edit', code: 'lima_resize_failed', cancelled: true },
  ])('retains projected stderr for failed or cancelled $command (cancelled=$cancelled)', async ({ command, code, cancelled }) => {
    const stderr = `token=private-token ${'x'.repeat(10_100)} failed to open "/private/secret/image": no such file or directory`;
    const exec: Pick<ExecService, 'run'> = { run: async () => ({ ...success(),
      termination: { observed: { kind: 'exit', exitCode: cancelled ? 0 : 1 }, requestedBy: cancelled ? { kind: 'abort' } : { kind: 'none' } },
      stderr: new TextEncoder().encode(stderr),
    }) };
    const executor = createLimaSdkExecutor({ exec, executable, signal: new AbortController().signal });
    const error = await executor.capture('limactl', [command, identity.instance]).catch(error => error);
    expect(error).toMatchObject({ code, nativeCause: { localCause: 'native_command_failed',
      command, exitCode: cancelled ? null : 1, stderrTruncated: true } });
    expect(error.nativeCause.stderr.length).toBeLessThanOrEqual(10_000);
    expect(error.nativeCause.stderr).toContain('no such file or directory');
    expect(error.nativeCause.stderr).not.toContain('/private/secret');
    expect(error.nativeCause.stderr).not.toContain('private-token');
  });
});
