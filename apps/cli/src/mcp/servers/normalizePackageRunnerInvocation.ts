import { basename } from 'node:path';

import { ensureManagedPnpmCommand } from '@/runtime/managedTools/pnpm/managedPnpm';

export type NormalizedPackageRunnerInvocation = Readonly<{
  command: string;
  args: string[];
  cwdPolicy: 'neutral' | 'workspace';
}>;

function normalizeNpxLikeArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '-y' || arg === '--yes' || arg === '--prefer-offline') {
      continue;
    }
    if (arg.startsWith('--package=') || arg.startsWith('-p=')) {
      out.push(arg);
      continue;
    }
    if ((arg === '-p' || arg === '--package') && index + 1 < args.length) {
      out.push(arg, args[index + 1]!);
      index += 1;
      continue;
    }
    if (arg === '--') continue;
    out.push(arg);
  }
  return out;
}

function normalizeExecArgs(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== '--');
}

function hasPackageFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '-p' || arg === '--package' || arg.startsWith('--package=') || arg.startsWith('-p='));
}

export async function normalizePackageRunnerInvocation(params: Readonly<{
  command: string;
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<NormalizedPackageRunnerInvocation | null> {
  const processEnv = params.processEnv ?? process.env;
  const normalized = basename(params.command).toLowerCase();
  const args = [...params.args];

  const resolvePnpmCommand = async (): Promise<string | null> => {
    return await ensureManagedPnpmCommand(processEnv);
  };

  if (normalized === 'npx' || normalized === 'npx.cmd' || normalized === 'bunx' || normalized === 'bunx.cmd') {
    const pnpmCommand = await resolvePnpmCommand();
    if (!pnpmCommand) return null;
    return { command: pnpmCommand, args: ['dlx', ...normalizeNpxLikeArgs(args)], cwdPolicy: 'neutral' };
  }

  if (normalized === 'npm' || normalized === 'npm.cmd') {
    const subcommand = args[0] ?? '';
    if (subcommand === 'run') {
      const pnpmCommand = await resolvePnpmCommand();
      if (!pnpmCommand) return null;
      return { command: pnpmCommand, args, cwdPolicy: 'workspace' };
    }
    if (subcommand === 'exec') {
      const pnpmCommand = await resolvePnpmCommand();
      if (!pnpmCommand) return null;
      const execArgs = args.slice(1);
      if (hasPackageFlag(execArgs)) {
        return { command: pnpmCommand, args: ['dlx', ...normalizeNpxLikeArgs(execArgs)], cwdPolicy: 'neutral' };
      }
      return { command: pnpmCommand, args: ['exec', ...normalizeExecArgs(execArgs)], cwdPolicy: 'workspace' };
    }
    return null;
  }

  if (normalized === 'yarn' || normalized === 'yarn.cmd' || normalized === 'yarnpkg' || normalized === 'yarnpkg.cmd') {
    if (args[0] === 'dlx') {
      const pnpmCommand = await resolvePnpmCommand();
      if (!pnpmCommand) return null;
      return { command: pnpmCommand, args: ['dlx', ...args.slice(1)], cwdPolicy: 'neutral' };
    }
    return null;
  }

  if (normalized === 'pnpm' || normalized === 'pnpm.cmd') {
    const pnpmCommand = await resolvePnpmCommand();
    if (!pnpmCommand) return null;
    const subcommand = args[0] ?? '';
    return {
      command: pnpmCommand,
      args,
      cwdPolicy: subcommand === 'run' || subcommand === 'exec' ? 'workspace' : 'neutral',
    };
  }

  return null;
}
