import { spawn } from 'node:child_process';

import { resolveYarnCommandInvocation } from '../../workspaces/execYarnCommand.mjs';

export interface YarnCommand {
  args: readonly string[];
}

export async function runYarnCommand(command: YarnCommand, rootDir: string): Promise<void> {
  const yarn = resolveYarnCommandInvocation([...command.args], { npmExecPath: process.env.npm_execpath });
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(yarn.command, [...yarn.args], {
      cwd: rootDir,
      stdio: 'inherit',
      ...(yarn.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`terminated with signal ${signal}`));
      else if (code !== 0) rejectRun(new Error(`exited with status ${code ?? 1}`));
      else resolveRun();
    });
  });
}
