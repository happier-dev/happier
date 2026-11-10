import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { changeLimaPower, execLimaGuest, putLimaGuestFile } from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import { createLimaSdkExecutor } from './nativeExecutor.js';

const executable: ManagedExecutableRef = { kind: 'managedDependency', id: { pluginId: 'happier.machine.lima', localId: 'lima-cli' } };
const identity = { instance: 'happier-test', store: '/private/lima-test' };
const native = { name: identity.instance, dir: `${identity.store}/${identity.instance}`, status: 'Running' };

function success(stdout = new Uint8Array()): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

describe('public Lima process transport', () => {
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
    expect(shell?.env).toEqual({ LIMA_HOME: identity.store });
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
