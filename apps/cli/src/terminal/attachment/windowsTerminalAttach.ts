import { spawn } from 'node:child_process';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { normalizeWindowsTerminalWindowName } from '@happier-dev/protocol';

export async function focusWindowsTerminalWindow(params: {
  windowId: string;
}): Promise<number> {
  const windowId = normalizeWindowsTerminalWindowName(params.windowId);
  if (windowId === 'new') return 1;

  return await new Promise((resolve) => {
    const terminalExecutable = resolveWindowsCommandOnPath('wt.exe') ?? 'wt.exe';
    const child = spawn(terminalExecutable, ['-w', windowId, 'focus-tab', '-t', '0'], {
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
