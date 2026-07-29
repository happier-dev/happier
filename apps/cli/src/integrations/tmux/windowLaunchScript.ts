import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPosixShellCommand,
  buildPosixShellEnvironmentAssignments,
} from '@happier-dev/agents/process/shellCommand';

export type PreparedTmuxWindowLaunch = Readonly<{
  command: string;
  cleanup: () => Promise<void>;
}>;

/**
 * Carries window-scoped environment values through a private one-shot file so
 * they never become tmux client arguments. The child shell removes inherited
 * owned keys before invoking any helper, unlinks the file, and exports the
 * prepared environment only after readiness signaling succeeds.
 */
export async function prepareTmuxWindowLaunch(input: Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  unsetEnvKeys: readonly string[];
  readySignal: string;
}>): Promise<PreparedTmuxWindowLaunch> {
  const directory = await mkdtemp(join(tmpdir(), 'happier-tmux-window-'));
  try {
    const scriptPath = join(directory, 'launch.sh');
    const assignments = buildPosixShellEnvironmentAssignments(input.env);
    const lines = [
      '#!/bin/sh',
      ...(input.unsetEnvKeys.length > 0 ? [`unset ${input.unsetEnvKeys.join(' ')}`] : []),
      buildPosixShellCommand(['rm', '-f', '--', scriptPath]),
      `${buildPosixShellCommand(['rmdir', '--', directory])} 2>/dev/null || true`,
      `${buildPosixShellCommand(['tmux', 'wait-for', '-S', input.readySignal])} || exit $?`,
      ...(assignments.length > 0 ? [`export ${assignments}`] : []),
      `exec ${buildPosixShellCommand(input.args)}`,
      '',
    ];
    await writeFile(scriptPath, lines.join('\n'), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });

    let cleaned = false;
    return {
      command: buildPosixShellCommand(['/bin/sh', scriptPath]),
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
