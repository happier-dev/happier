import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { isBun } from '@/utils/runtime';
import { isClaudeCliJavaScriptFile } from '@/backends/claude/utils/resolveClaudeCliPath';

export async function probeClaudeHelpText(params: Readonly<{ cwd: string; timeoutMs: number }>): Promise<string | null> {
  const timeoutMs = Math.max(250, params.timeoutMs);

  let command: string;
  let args: string[];
  let env: NodeJS.ProcessEnv | undefined;
  let windowsVerbatimArguments: boolean | undefined;

  try {
    const launch = requireProviderCliLaunchSpec('claude');
    if (isClaudeCliJavaScriptFile(launch.resolvedPath)) {
      const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
        isBunRuntime: isBun(),
        targetLabel: 'Claude Code help probe',
      });
      const invocation = resolveWindowsCommandInvocation({
        command: runtimeExecutable,
        args: [launch.resolvedPath, '--help'],
        env: process.env,
      });
      command = invocation.command;
      args = [...invocation.args];
      env = process.env;
      windowsVerbatimArguments = invocation.windowsVerbatimArguments ? true : undefined;
    } else {
      const invocation = resolveWindowsCommandInvocation({
        command: launch.command,
        args: [...launch.args, '--help'],
        env: process.env,
      });
      command = invocation.command;
      args = [...invocation.args];
      windowsVerbatimArguments = invocation.windowsVerbatimArguments ? true : undefined;
    }
  } catch (error) {
    // Fail closed: if Claude CLI is unavailable/unresolvable, skip probe.
    if (error instanceof Error && error.name === 'ReferenceError') {
      return null;
    }
    return null;
  }

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd: params.cwd,
      env: { ...process.env, CI: '1', ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);
      // Prefer stdout but fall back to stderr for CLIs that print help there.
      const output = stdout.trim() ? stdout : stderr;
      finish(output.trim() ? output.trim() : null);
    });
  });
}
