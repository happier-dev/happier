import { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { deleteLumeNativeVm } from './nativeDelete.js';
import { lumeProcessResult } from './nativeClient.testkit.js';

const resource = { storage: '/Volumes/VM storage', vmName: '-owned vm' };
const executable = { kind: 'managedDependency' as const, id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } };

describe('Lume v0.6.1 managed native Delete process', () => {
  it('passes exact identity as literal arguments and awaits native completion', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const signal = new AbortController().signal;
    const exec = { run: async (request: Parameters<ExecService['run']>[0], options?: Parameters<ExecService['run']>[1]) => {
      requests.push(request);
      expect(options?.signal).toBe(signal);
      return { ...lumeProcessResult(), stdoutTruncated: true };
    } };
    expect(await deleteLumeNativeVm({ exec, executable, resource, signal })).toEqual({ kind: 'delete-accepted', resource });
    expect(requests).toEqual([{ executable, args: ['delete', '--force', '--storage', resource.storage, '--', resource.vmName] }]);
  });
  it.each([1, 64])('retains native exit %s without projecting stdout or certifying deletion', async exitCode => {
    const result: PluginProcessResult = { ...lumeProcessResult(exitCode), stdout: new TextEncoder().encode('private native content') };
    expect(await deleteLumeNativeVm({ exec: { run: async () => result }, executable, resource })).toEqual({
      kind: 'unknown', reason: 'native_command_failed', resource,
      nativeCause: { localCause: 'native_command_failed', command: 'delete', exitCode },
    });
  });
  it.each([false, true])('retains a bounded privacy-projected native failure diagnostic (long=%s)', async long => {
    const stderr = `Delete refused: client_secret=delete-secret-sentinel\n${long ? 'context '.repeat(MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1) : ''}Delete refused: native lock held`;
    const result = { ...lumeProcessResult(1), stderr: new TextEncoder().encode(stderr), stderrTruncated: true };
    const failure = await deleteLumeNativeVm({ exec: { run: async () => result }, executable, resource });
    expect(failure).toMatchObject({ kind: 'unknown', nativeCause: { localCause: 'native_command_failed',
      command: 'delete', exitCode: 1, stderr: expect.stringContaining('Delete refused:'), stderrTruncated: true } });
    expect(JSON.stringify(failure)).not.toContain('delete-secret-sentinel');
    if (failure.kind !== 'unknown') throw new Error('Expected native failure');
    if (failure.nativeCause && 'stderr' in failure.nativeCause) expect(failure.nativeCause.stderr?.length).toBeLessThanOrEqual(MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1);
  });
  it('does not call a canceled process and preserves a typed host refusal', async () => {
    const refusal = new PluginError({ code: 'plugin_exec_refused', details: { phase: 'native-delete' } });
    let effects = 0;
    const exec = { run: async () => { effects++; throw refusal; } };
    await expect(deleteLumeNativeVm({ exec, executable, resource, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(effects).toBe(0);
    await expect(deleteLumeNativeVm({ exec, executable, resource })).rejects.toBe(refusal);
  });
  it('retains unknown completion when the process was canceled despite a zero observed exit', async () => {
    const result: PluginProcessResult = { ...lumeProcessResult(), termination: {
      observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'abort' },
    } };
    expect(await deleteLumeNativeVm({ exec: { run: async () => result }, executable, resource })).toMatchObject({
      kind: 'unknown', nativeCause: { localCause: 'native_command_failed', command: 'delete', exitCode: null },
    });
  });
});
