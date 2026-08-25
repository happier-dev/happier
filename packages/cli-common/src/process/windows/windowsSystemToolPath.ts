import { win32 } from 'node:path';

/**
 * The Windows tools this repository executes directly, and where Windows keeps them.
 *
 * Every one of these is a system binary shipped inside `%SystemRoot%\System32`. Invoking them by
 * bare name defers the choice of executable to whatever `PATH` the *invoking* process happens to
 * carry, which is not the same search for the daemon, the PowerShell dispatcher it starts, and the
 * cancellation path that runs later: availability, launch, inventory and termination could each
 * resolve a different binary. Naming the location once here makes those four steps refer to one
 * executable, and keeps a `PATH` entry ahead of `System32` from taking over a process-custody
 * operation.
 *
 * `wt.exe` is deliberately absent: Windows Terminal is a Store app-execution alias under
 * `%LOCALAPPDATA%`, not a system tool, so it is resolved with the canonical `PATH` resolver
 * (`resolveWindowsCommandOnPath`) at its launch owner and threaded from there.
 */
const WINDOWS_SYSTEM_TOOL_SYSTEM32_PATHS = Object.freeze({
  'icacls.exe': ['icacls.exe'],
  'powershell.exe': ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'taskkill.exe': ['taskkill.exe'],
  'whoami.exe': ['whoami.exe'],
} satisfies Readonly<Record<string, readonly string[]>>);

export type WindowsSystemToolName = keyof typeof WINDOWS_SYSTEM_TOOL_SYSTEM32_PATHS;

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | null {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== expected) continue;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Absolute `System32` path of a Windows system tool, or `null` when this environment does not say
 * where Windows is installed.
 *
 * A `null` is the caller's cue to fall back to the bare command name. That fallback is not a second
 * resolution owner: it is the same answer for every call site, so the tools still cannot disagree
 * with each other — they only lose the `System32` pin, which is all `%SystemRoot%` can buy.
 */
export function resolveWindowsSystemToolPath(
  tool: WindowsSystemToolName,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const windowsRoot = readEnvValueCaseInsensitive(env, 'SystemRoot')
    ?? readEnvValueCaseInsensitive(env, 'WINDIR');
  if (!windowsRoot) return null;
  return win32.join(windowsRoot, 'System32', ...WINDOWS_SYSTEM_TOOL_SYSTEM32_PATHS[tool]);
}

/** `resolveWindowsSystemToolPath` for callers that must not run the tool at all without the pin. */
export function requireWindowsSystemToolPath(
  tool: WindowsSystemToolName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = resolveWindowsSystemToolPath(tool, env);
  if (!resolved) {
    throw new Error(`Cannot run Windows system tool ${tool}: SystemRoot and WINDIR are unavailable`);
  }
  return resolved;
}

/** Bare-name fallback shared by every consumer, so an unpinned run is still one decision. */
export function windowsSystemToolCommand(
  tool: WindowsSystemToolName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveWindowsSystemToolPath(tool, env) ?? tool;
}
