import { describe, expect, it } from 'vitest';

import { buildTerminalCleanupFenceCommands } from './cleanupFence';

describe('terminal cleanup fence commands', () => {
  it('scopes stale string-path checks to terminal-owned paths', () => {
    const commands = buildTerminalCleanupFenceCommands();
    const text = commands.join('\n');
    const stringPathFence = commands.find((command) => command.includes('DaemonTerminalStreamEventDataSchema'));

    expect(text).toContain('apps/cli/src/daemon');
    expect(text).toContain('apps/ui/sources/components/terminal');
    expect(text).toContain('packages/protocol/src/daemon/terminal.ts');
    expect(text).not.toContain('packages/protocol/src/daemonTerminal.ts');
    expect(text).not.toContain('rg -n "DaemonTerminalStreamEventDataSchema|data: string" packages apps');
    expect(text).not.toContain('packages apps');
    expect(stringPathFence).toContain("--glob '!**/*.test.*'");
    expect(stringPathFence).toContain("--glob '!**/__tests__/**'");
    expect(stringPathFence).toContain("--glob '!**/*.generated.*'");
  });

  it('keeps plugin SDK terminal transport exposure as a separate fence', () => {
    const commands = buildTerminalCleanupFenceCommands();
    const pluginFence = commands.find((command) => command.includes('TerminalStreamFrame'));

    expect(pluginFence).toContain('ctx\\\\.terminal\\\\b');
    expect(pluginFence).not.toContain('ctx\\\\.terminal|');
    expect(pluginFence).toContain('terminal[._-]?byte[._-]?stream');
  });
});
