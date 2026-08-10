import { spawn } from 'node:child_process';

import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';
import { toPowerShellStringLiteral } from '@/utils/powerShellCommand';

type PowerShellInvocation = {
  command: string;
  args: string[];
};

const WINDOWS_TERMINAL_HOST_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'ComSpec',
]);

function quoteWindowsProcessArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;

  let quoted = '"';
  let backslashCount = 0;

  for (const char of value) {
    if (char === '\\') {
      backslashCount += 1;
      continue;
    }

    if (char === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1);
      quoted += '"';
      backslashCount = 0;
      continue;
    }

    if (backslashCount > 0) {
      quoted += '\\'.repeat(backslashCount);
      backslashCount = 0;
    }
    quoted += char;
  }

  if (backslashCount > 0) {
    quoted += '\\'.repeat(backslashCount * 2);
  }

  return `${quoted}"`;
}

function escapeWindowsTerminalCommandSeparator(value: string): string {
  return value.replaceAll(';', '\\;');
}

function parsePowerShellStartProcessPid(stdout: string): number | null {
  const trimmed = stdout.replaceAll('\u0000', '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\b(\d+)\b/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : null;
}

function buildWindowsTerminalProcessEnv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  inheritParentEnv?: boolean | undefined;
}>): NodeJS.ProcessEnv {
  if (params.inheritParentEnv !== false) {
    return { ...process.env, ...params.env };
  }

  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && isAllowedExactEnvKey(key, WINDOWS_TERMINAL_HOST_ENV_KEYS, 'win32')) {
      base[key] = value;
    }
  }
  return { ...base, ...params.env };
}

export function buildPowerShellStartWindowsTerminalInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  windowId: string;
  title: string;
}): PowerShellInvocation {
  const argsArray = [
    '-w',
    params.windowId,
    'new-tab',
    '--title',
    params.title,
    '--startingDirectory',
    params.workingDirectory,
    params.filePath,
    ...params.args,
  ];
  const argsCommandLine = argsArray
    .map(escapeWindowsTerminalCommandSeparator)
    .map((arg) => quoteWindowsProcessArgument(arg))
    .join(' ');
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath 'wt.exe' -ArgumentList ${toPowerShellStringLiteral(argsCommandLine)} -WorkingDirectory ${toPowerShellStringLiteral(params.workingDirectory)} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}

export async function startProcessInWindowsTerminal(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  windowId: string;
  title: string;
  inheritParentEnv?: boolean | undefined;
}): Promise<{ ok: true; pid: number } | { ok: false; errorMessage: string }> {
  const invocation = buildPowerShellStartWindowsTerminalInvocation(params);

  return await new Promise((resolve) => {
    let settled = false;
    const safeResolve = (result: { ok: true; pid: number } | { ok: false; errorMessage: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(invocation.command, invocation.args, {
      cwd: params.workingDirectory,
      env: buildWindowsTerminalProcessEnv(params),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });
    child.stderr?.on('data', (data) => {
      stderr += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    });

    child.once('error', (error) => {
      safeResolve({ ok: false, errorMessage: error instanceof Error ? error.message : 'Failed to spawn PowerShell' });
    });

    child.once('close', (code) => {
      if (code !== 0) {
        safeResolve({ ok: false, errorMessage: `PowerShell exit ${code}. ${stderr.trim() || stdout.trim()}`.trim() });
        return;
      }

      const pid = parsePowerShellStartProcessPid(stdout);
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        safeResolve({ ok: false, errorMessage: `Failed to parse PID from PowerShell output: ${stdout.trim()}` });
        return;
      }
      safeResolve({ ok: true, pid });
    });
  });
}
