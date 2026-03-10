import { spawn } from 'node:child_process';

export async function focusWindowsTerminalWindow(params: {
  windowId: string;
}): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn('wt.exe', ['-w', params.windowId, 'focus-tab', '-t', '0'], {
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
