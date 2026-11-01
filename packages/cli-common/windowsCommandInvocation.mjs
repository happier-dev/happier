import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { delimiter as pathDelimiter, dirname, join, normalize as normalizePath } from 'node:path';
function asNonEmptyString(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
function readEnvPath(env) {
  // Windows env vars are case-insensitive; Node may expose PATH as `Path`.
  return readEnvValueCaseInsensitive(env, 'PATH') ?? '';
}
function readEnvPathext(env) {
  return readEnvValueCaseInsensitive(env, 'PATHEXT') ?? '';
}
function readEnvValueCaseInsensitive(env, name) {
  const direct = env[name];
  if (typeof direct === 'string')
    return direct;
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== lowered)
      continue;
    return typeof value === 'string' ? value : null;
  }
  return null;
}
function normalizePathext(pathext) {
  const raw = asNonEmptyString(pathext) ?? '.EXE;.CMD;.BAT;.COM';
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith('.') ? part : `.${part}`));
}
function expandPathextCaseVariants(exts) {
  const seen = new Set();
  const variants = [];
  for (const ext of exts) {
    for (const candidate of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
      if (seen.has(candidate))
        continue;
      seen.add(candidate);
      variants.push(candidate);
    }
  }
  return variants;
}
function isCommandOnly(command) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed)
    return false;
  if (trimmed.includes('/') || trimmed.includes('\\'))
    return false;
  if (trimmed.includes(':'))
    return false;
  return true;
}
function isWindowsShellShimPath(pathLike) {
  return /\.(cmd|bat)$/i.test(String(pathLike ?? '').trim());
}
function isWindowsCmdExeCommand(command) {
  return /^cmd(?:\.exe)?$/i.test(String(command ?? '').trim());
}
function buildWindowsCommandCandidates(commandLike, env) {
  const cmd = asNonEmptyString(commandLike);
  if (!cmd)
    return [];
  const exts = expandPathextCaseVariants(normalizePathext(readEnvPathext(env)));
  const lowered = cmd.toLowerCase();
  const hasKnownExt = exts.some((ext) => lowered.endsWith(ext.toLowerCase()));
  return hasKnownExt ? [cmd] : [...exts.map((ext) => `${cmd}${ext}`), cmd];
}
function resolveNativeNpmShimTarget(command) {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(command)) return command;
  try {
    // npm cmd-shim 7's no-shebang template only computes its directory and
    // forwards argv. Match the whole script so custom auth/env/argument work
    // is never bypassed. Claude Code 2.1.270 uses this for bin/claude.exe.
    const script = readFileSync(command, 'utf8').replace(/\r\n/g, '\n');
    const match = /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%[\\/]([^"\r\n%!^]+\.exe)"[ \t]+%\*\n?$/.exec(script);
    if (!match) return command;
    const target = join(dirname(command), ...match[1].split(/[\\/]/));
    // npm can leave a text placeholder when native installation did not run.
    const fd = openSync(target, 'r');
    try {
      const magic = Buffer.alloc(2);
      if (readSync(fd, magic, 0, magic.length, 0) === 2 && magic[0] === 0x4d && magic[1] === 0x5a) return target;
    } finally {
      closeSync(fd);
    }
  } catch {
    // An unproven delegate retains normal shell launch and its failure reporting.
  }
  return command;
}
export function resolveWindowsCommandPath(commandPath, env = process.env) {
  for (const candidate of buildWindowsCommandCandidates(commandPath, env)) {
    try {
      if (existsSync(candidate))
        return resolveNativeNpmShimTarget(candidate);
    }
    catch {
      // ignore
    }
  }
  return null;
}
/**
 * The first `command` on PATH, trying each PATHEXT spelling per directory. `accept` skips matches the
 * caller already knows are not the one it looks for (the managed `happier.exe` when looking for a
 * `happier` the user installed), so the search goes on to the next match instead of stopping there.
 */
export function resolveWindowsCommandOnPath(command, env = process.env, accept = () => true) {
  const cmd = asNonEmptyString(command);
  if (!cmd)
    return null;
  const pathEnv = asNonEmptyString(readEnvPath(env));
  if (!pathEnv)
    return null;
  const candidates = buildWindowsCommandCandidates(cmd, env);
  for (const dir of pathEnv.split(pathDelimiter)) {
    const trimmedDir = dir.trim();
    if (!trimmedDir)
      continue;
    for (const name of candidates) {
      const full = join(trimmedDir, name);
      try {
        if (existsSync(full) && accept(full))
          return resolveNativeNpmShimTarget(full);
      }
      catch {
        // ignore
      }
    }
  }
  return null;
}
// See http://www.robvanderwoude.com/escapechars.php
const cmdMetaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;
const nodeModulesCmdShimRegExp = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;
function escapeCmdCommand(arg) {
  return arg.replace(cmdMetaCharsRegExp, '^$1');
}
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
export function buildWindowsCmdShimInvocation(command, args, options = {}) {
  const resolvedCommand = normalizePath(command);
  const comspec = resolveWindowsCmdExeCommand(options.env ?? process.env, options.comspec);
  const needsDoubleEscape = nodeModulesCmdShimRegExp.test(resolvedCommand);
  const shellCommand = [escapeCmdCommand(resolvedCommand), ...args.map((arg) => escapeCmdArgument(arg, needsDoubleEscape))].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}
function resolveWindowsCmdExeCommand(env, explicitComspec) {
  const configured = asNonEmptyString(explicitComspec) ??
    asNonEmptyString(readEnvValueCaseInsensitive(env, 'COMSPEC'));
  if (configured) {
    return resolveWindowsCommandPath(configured, env) ?? configured;
  }
  const windowsRoot = asNonEmptyString(readEnvValueCaseInsensitive(env, 'SystemRoot')) ??
    asNonEmptyString(readEnvValueCaseInsensitive(env, 'WINDIR'));
  if (windowsRoot) {
    const cmdPath = join(windowsRoot, 'System32', 'cmd.exe');
    return resolveWindowsCommandPath(cmdPath, env) ?? cmdPath;
  }
  return resolveWindowsCommandOnPath('cmd.exe', env) ?? 'cmd.exe';
}
export function resolveWindowsCommandInvocation(params) {
  const command = String(params.command ?? '').trim();
  const args = Array.isArray(params.args) ? params.args.map((a) => String(a)) : [];
  if (process.platform !== 'win32') {
    return { command, args };
  }
  const env = params.env ?? process.env;
  if (isCommandOnly(command) && isWindowsCmdExeCommand(command)) {
    return { command: resolveWindowsCmdExeCommand(env, params.comspec), args };
  }
  const shouldResolveOnPath = params.resolveCommandOnPath !== false;
  const resolvedCommand = shouldResolveOnPath && isCommandOnly(command)
    ? (resolveWindowsCommandOnPath(command, env) ?? command)
    : (resolveWindowsCommandPath(command, env) ?? command);
  if (!isWindowsShellShimPath(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }
  return buildWindowsCmdShimInvocation(resolvedCommand, args, { env, comspec: params.comspec });
}
