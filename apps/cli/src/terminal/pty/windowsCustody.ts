import { randomUUID } from 'node:crypto';

import {
  createFiniteProcessCustodyInvocation,
  createProcessCustodyHandshakePath,
  createWindowsJobCustodyName,
  removeProcessCustodyHandshakeFile,
  resolveProcessCustodyRuntimeExecutable,
  waitForProcessCustodyHandshake,
} from '@/subprocess/supervision/processCustody';

import type { PtyProvider } from './provider';

/** Adapt PTY launch to the incumbent native Job owner; interactive shells stay unchanged. */
export function withWindowsFiniteCustody(provider: PtyProvider, options: Readonly<{
  platform: NodeJS.Platform;
  resolveProcessCustodyRuntimeExecutable?: typeof resolveProcessCustodyRuntimeExecutable;
}>): PtyProvider {
  if (options.platform !== 'win32') return provider;
  return {
    spawn(input) {
      if (!input.finiteProcess) return provider.spawn(input);
      const executablePath = (options.resolveProcessCustodyRuntimeExecutable ?? resolveProcessCustodyRuntimeExecutable)('win32');
      if (!executablePath) throw new Error('terminal_spawn_failed');
      const custody = {
        executablePath,
        jobName: createWindowsJobCustodyName(randomUUID()),
        handshakePath: createProcessCustodyHandshakePath(),
      };
      const invocation = createFiniteProcessCustodyInvocation({ custody, command: input.file, args: input.args });
      // The selected backend may fall back to the direct Node relay. The helper
      // invocation is already contained; do not create a nested Job there.
      const pty = provider.spawn({ file: invocation.command, args: [...invocation.args], options: input.options });
      const established = waitForProcessCustodyHandshake(custody);
      pty.onExit(() => {
        // Preserve the establishment read even for a very short-lived target.
        // Retire only this invocation's owned marker after that read settles.
        void established.then(() => removeProcessCustodyHandshakeFile(custody.handshakePath));
      });
      return { ...pty, windowsJobCustody: { ...custody, established } };
    },
  };
}
