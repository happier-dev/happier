import { afterEach, describe, expect, it, vi } from 'vitest';

describe('claude_version_utils: findClaudeInPath (win32)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('prefers claude.exe over claude.cmd when "where claude" returns multiple matches', async () => {
    const mod = await import('../scripts/claude_version_utils.cjs');
    const pick = mod.pickClaudePathFromWhichOrWhereOutput;

    const cmd = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
    const exe = 'C:\\Users\\me\\AppData\\Local\\Claude\\claude.exe';
    const output = `${cmd}\r\n${exe}\r\n`;

    const selected = pick(output, 'win32', () => true);
    expect(selected).toBe(exe);
  });

  it('avoids WindowsApps app-execution-alias stubs when another match exists', async () => {
    const mod = await import('../scripts/claude_version_utils.cjs');
    const pick = mod.pickClaudePathFromWhichOrWhereOutput;

    const windowsAppsExe = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe';
    const npmCmd = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
    const output = `${windowsAppsExe}\r\n${npmCmd}\r\n`;

    const selected = pick(output, 'win32', () => true);
    expect(selected).toBe(npmCmd);
  });
});
