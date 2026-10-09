import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { execLimaGuest, putLimaGuestFile } from '@happier-dev/cli-common/machineLima';
import { createLimaSdkExecutor } from './nativeExecutor.js';

const executable: ManagedExecutableRef = { kind: 'managedDependency', id: { pluginId: 'happier.machine.lima', localId: 'lima-cli' } };
const identity = { instance: 'happier-test', store: '/private/lima-test' };
const native = { name: identity.instance, dir: `${identity.store}/${identity.instance}`, status: 'Running' };

function success(stdout = new Uint8Array()): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    stdout, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

describe('public Lima process transport', () => {
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
});
