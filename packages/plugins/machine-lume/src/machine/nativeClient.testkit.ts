import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createLumeNativeClient } from './nativeClient.js';

export function lumeProcessResult(exitCode = 0): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}

export function createLumeNativeClientForTest(options: Omit<Parameters<typeof createLumeNativeClient>[0], 'command'> &
  Partial<Pick<Parameters<typeof createLumeNativeClient>[0], 'command'>>) {
  return createLumeNativeClient({ ...options, command: options.command ?? {
    executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
    exec: { run: async () => { throw new Error('Unexpected native Lume Delete process'); } },
  } });
}
