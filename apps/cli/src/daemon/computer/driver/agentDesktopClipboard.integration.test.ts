import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { expect, it } from 'vitest';

import { createComputerDesktop } from '../desktop';
import { createAgentDesktopComputerDriver } from './agentDesktopDriver';

const executablePath = process.env.HAPPIER_TEST_AGENT_DESKTOP_EXECUTABLE;
const available = process.platform === 'linux' && executablePath
  && ['Xvfb', 'dbus-daemon', 'gdbus', 'xclip'].every(name => resolveExecutableCommand(name))
  && (resolveExecutableCommand('openbox') || resolveExecutableCommand('fluxbox'));

it.skipIf(!available)('writes a canary through real xclip stdin and reads it through the pinned native driver on a private desktop', async () => {
  const desktop = createComputerDesktop();
  let driver: Awaited<ReturnType<typeof createAgentDesktopComputerDriver>> | undefined;
  try {
    const connection = await desktop.ensure();
    driver = await createAgentDesktopComputerDriver({ ...connection, executablePath: executablePath! });
    const target = { kind: 'display', displayId: connection.displayId } as const;
    const text = 'COMPUTER-FIX-1107-canary';
    expect(await driver.clipboard?.(target, { kind: 'write', text })).toEqual({ ok: true });
    expect(await driver.clipboard?.(target, { kind: 'read' })).toEqual({ ok: true, text });
  } finally {
    await driver?.close();
    await desktop.dispose();
  }
});
