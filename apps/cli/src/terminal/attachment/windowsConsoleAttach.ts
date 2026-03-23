import { spawn } from 'node:child_process';

function buildFocusConsoleScript(pid: number): string {
  return [
    '$ErrorActionPreference = "Stop";',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class HappierWin32 {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@;',
    `$p = Get-Process -Id ${pid};`,
    'if (-not $p.MainWindowHandle -or $p.MainWindowHandle -eq 0) { exit 1 }',
    '[HappierWin32]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null;',
    '[HappierWin32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;',
  ].join(' ');
}

export async function focusWindowsConsoleWindow(params: {
  pid: number;
}): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildFocusConsoleScript(params.pid)], {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
