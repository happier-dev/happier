import { describe, expect, it } from 'vitest';
import { buildPowerShellStartProcessInvocation, parsePowerShellStartProcessPid } from './visibleConsoleSpawn';

describe('visibleConsoleSpawn', () => {
  it('builds a powershell Start-Process invocation that prints the pid', () => {
    const inv = buildPowerShellStartProcessInvocation({
      filePath: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['--no-warnings', 'C:\\repo\\dist\\index.mjs', 'claude', '--happy-starting-mode', 'remote'],
      workingDirectory: 'C:\\repo',
    });

    expect(inv.command.toLowerCase()).toContain('powershell');
    expect(inv.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']));
    const commandIndex = inv.args.indexOf('-Command');
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    const script = inv.args[commandIndex + 1] ?? '';
    expect(script).toContain('Start-Process');
    expect(script).toContain('-PassThru');
    expect(script).toContain('$p.Id');
    expect(script).toContain('-WorkingDirectory');
    expect(script).toContain('C:\\repo');
  });

  it('escapes single quotes in PowerShell literals', () => {
    const inv = buildPowerShellStartProcessInvocation({
      filePath: "C:\\repo\\it's-node.exe",
      args: ["--name", "O'Brien"],
      workingDirectory: "C:\\repo\\team's-worktree",
    });
    const commandIndex = inv.args.indexOf('-Command');
    const script = inv.args[commandIndex + 1] ?? '';
    expect(script).toContain("it''s-node.exe");
    expect(script).toContain("O''Brien");
    expect(script).toContain("team''s-worktree");
  });

  it('parses a pid from powershell output', () => {
    expect(parsePowerShellStartProcessPid('12345\r\n')).toBe(12345);
  });

  it('parses pid from noisy multiline output', () => {
    expect(parsePowerShellStartProcessPid('Starting process...\r\nPID: 43210\r\n')).toBe(43210);
  });

  it('parses pid from UTF-16-ish output that includes NUL separators', () => {
    expect(parsePowerShellStartProcessPid('4\u00003\u00002\u00001\u00000\r\n')).toBe(43210);
  });

  it('returns null when powershell output has no pid', () => {
    expect(parsePowerShellStartProcessPid('oops')).toBeNull();
    expect(parsePowerShellStartProcessPid('')).toBeNull();
  });
});
