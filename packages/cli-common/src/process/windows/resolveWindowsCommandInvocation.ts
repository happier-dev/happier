import { existsSync } from 'node:fs';
import { delimiter as pathDelimiter, join, normalize as normalizePath } from 'node:path';

export type CommandInvocation = Readonly<{ command: string; args: string[]; windowsVerbatimArguments?: boolean }>;

function asNonEmptyString(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readEnvPath(env: NodeJS.ProcessEnv): string {
  // Windows env vars are case-insensitive; Node may expose PATH as `Path`.
  return String(env.PATH ?? (env as any).Path ?? '');
}

function readEnvPathext(env: NodeJS.ProcessEnv): string {
  return String(env.PATHEXT ?? (env as any).Pathext ?? '');
}

function normalizePathext(pathext: string): string[] {
  const raw = asNonEmptyString(pathext) ?? '.EXE;.CMD;.BAT;.COM';
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith('.') ? part : `.${part}`));
}

function expandPathextCaseVariants(exts: string[]): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const ext of exts) {
    for (const candidate of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      variants.push(candidate);
    }
  }
  return variants;
}

function isCommandOnly(command: string): boolean {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (trimmed.includes(':')) return false;
  return true;
}

function isWindowsShellShimPath(pathLike: string): boolean {
  return /\.(cmd|bat)$/i.test(String(pathLike ?? '').trim());
}

export function resolveWindowsCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const cmd = asNonEmptyString(command);
  if (!cmd) return null;

  const pathEnv = asNonEmptyString(readEnvPath(env));
  if (!pathEnv) return null;

  const exts = expandPathextCaseVariants(normalizePathext(readEnvPathext(env)));
  const lowered = cmd.toLowerCase();
  const hasKnownExt = exts.some((ext) => lowered.endsWith(ext.toLowerCase()));
  const candidates = hasKnownExt ? [cmd] : [cmd, ...exts.map((ext) => `${cmd}${ext}`)];

  for (const dir of pathEnv.split(pathDelimiter)) {
    const trimmedDir = dir.trim();
    if (!trimmedDir) continue;
    for (const name of candidates) {
      const full = join(trimmedDir, name);
      try {
        if (existsSync(full)) return full;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

// See http://www.robvanderwoude.com/escapechars.php
const cmdMetaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;
const nodeModulesCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

function escapeCmdCommand(arg: string): string {
  return arg.replace(cmdMetaCharsRegExp, '^$1');
}

function escapeCmdArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let s = `${arg}`;

  // Algorithm below is based on https://qntm.org/cmd
  // (Copied from cross-spawn)
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');

  // Quote the whole thing:
  s = `"${s}"`;

  // Escape meta chars
  s = s.replace(cmdMetaCharsRegExp, '^$1');
  if (doubleEscapeMetaChars) {
    s = s.replace(cmdMetaCharsRegExp, '^$1');
  }

  return s;
}

function buildCmdExeInvocation(params: Readonly<{ resolvedCommand: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv; comspec?: string | null }>): CommandInvocation {
  const resolvedCommand = normalizePath(params.resolvedCommand);
  const comspec =
    asNonEmptyString(params.comspec) ??
    asNonEmptyString((params.env as any).comspec) ??
    asNonEmptyString(params.env.ComSpec) ??
    asNonEmptyString((params.env as any).COMSPEC) ??
    'cmd.exe';

  const needsDoubleEscape = nodeModulesCmdShimRegExp.test(resolvedCommand);
  const shellCommand = [escapeCmdCommand(resolvedCommand), ...params.args.map((arg) => escapeCmdArgument(arg, needsDoubleEscape))].join(' ');

  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export function resolveWindowsCommandInvocation(params: Readonly<{
  command: string;
  args: ReadonlyArray<string>;
  env?: NodeJS.ProcessEnv;
  comspec?: string | null;
  resolveCommandOnPath?: boolean;
}>): CommandInvocation {
  const command = String(params.command ?? '').trim();
  const args = Array.isArray(params.args) ? params.args.map((a) => String(a)) : [];

  if (process.platform !== 'win32') {
    return { command, args };
  }

  const env = params.env ?? process.env;
  const shouldResolveOnPath = params.resolveCommandOnPath !== false;
  const resolvedCommand =
    shouldResolveOnPath && isCommandOnly(command)
      ? (resolveWindowsCommandOnPath(command, env) ?? command)
      : command;

  if (!isWindowsShellShimPath(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }

  return buildCmdExeInvocation({ resolvedCommand, args, env, comspec: params.comspec });
}
