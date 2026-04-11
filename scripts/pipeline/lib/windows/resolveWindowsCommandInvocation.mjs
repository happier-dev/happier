// @ts-check

import { existsSync } from 'node:fs';
import { delimiter as pathDelimiter, join, normalize as normalizePath } from 'node:path';

/**
 * @typedef {Readonly<{ command: string; args: string[]; windowsVerbatimArguments?: boolean }>} CommandInvocation
 */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asNonEmptyString(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Windows env vars are case-insensitive; Node may expose PATH as `Path`.
 * @param {NodeJS.ProcessEnv} env
 */
function readEnvPath(env) {
  return String(env.PATH ?? env.Path ?? '');
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function readEnvPathext(env) {
  return String(env.PATHEXT ?? env.Pathext ?? '');
}

/**
 * @param {string} pathext
 */
function normalizePathext(pathext) {
  const raw = asNonEmptyString(pathext) ?? '.EXE;.CMD;.BAT;.COM';
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith('.') ? part : `.${part}`));
}

/**
 * @param {string[]} exts
 */
function expandPathextCaseVariants(exts) {
  const seen = new Set();
  const variants = [];
  for (const ext of exts) {
    for (const candidate of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      variants.push(candidate);
    }
  }
  return variants;
}

/**
 * @param {string} command
 */
function isCommandOnly(command) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (trimmed.includes(':')) return false;
  return true;
}

/**
 * @param {string} pathLike
 */
function isWindowsShellShimPath(pathLike) {
  return /\.(cmd|bat)$/i.test(String(pathLike ?? '').trim());
}

/**
 * @param {string} commandLike
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function buildWindowsCommandCandidates(commandLike, env) {
  const cmd = asNonEmptyString(commandLike);
  if (!cmd) return [];

  const exts = expandPathextCaseVariants(normalizePathext(readEnvPathext(env)));
  const lowered = cmd.toLowerCase();
  const hasKnownExt = exts.some((ext) => lowered.endsWith(ext.toLowerCase()));
  return hasKnownExt ? [cmd] : [...exts.map((ext) => `${cmd}${ext}`), cmd];
}

/**
 * @param {string} commandPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveWindowsCommandPath(commandPath, env = process.env) {
  for (const candidate of buildWindowsCommandCandidates(commandPath, env)) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveWindowsCommandOnPath(command, env = process.env) {
  const cmd = asNonEmptyString(command);
  if (!cmd) return null;

  const pathEnv = asNonEmptyString(readEnvPath(env));
  if (!pathEnv) return null;

  const candidates = buildWindowsCommandCandidates(cmd, env);

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

/**
 * @param {string} arg
 */
function escapeCmdCommand(arg) {
  return arg.replace(cmdMetaCharsRegExp, '^$1');
}

/**
 * @param {string} arg
 * @param {boolean} doubleEscapeMetaChars
 */
function escapeCmdArgument(arg, doubleEscapeMetaChars) {
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

/**
 * @param {{ resolvedCommand: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv; comspec?: string | null }} params
 * @returns {CommandInvocation}
 */
function buildCmdExeInvocation(params) {
  const resolvedCommand = normalizePath(params.resolvedCommand);
  const comspec =
    asNonEmptyString(params.comspec) ??
    asNonEmptyString(params.env.comspec) ??
    asNonEmptyString(params.env.ComSpec) ??
    asNonEmptyString(params.env.COMSPEC) ??
    'cmd.exe';

  const needsDoubleEscape = nodeModulesCmdShimRegExp.test(resolvedCommand);
  const shellCommand = [escapeCmdCommand(resolvedCommand), ...params.args.map((arg) => escapeCmdArgument(arg, needsDoubleEscape))].join(' ');

  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * @param {{ command: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv; comspec?: string | null; resolveCommandOnPath?: boolean }} params
 * @returns {CommandInvocation}
 */
export function resolveWindowsCommandInvocation(params) {
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
      : (resolveWindowsCommandPath(command, env) ?? command);

  if (!isWindowsShellShimPath(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }

  return buildCmdExeInvocation({ resolvedCommand, args, env, comspec: params.comspec });
}
