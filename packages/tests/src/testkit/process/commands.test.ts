import { describe, expect, it } from 'vitest';

import { resolveNpmCommandInvocation } from './commands';

describe('resolveNpmCommandInvocation', () => {
  it('wraps npm.cmd through cmd.exe on Windows to avoid direct .cmd spawn failures', () => {
    const invocation = resolveNpmCommandInvocation(['pack', '--silent'], {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    });

    expect(invocation.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args[0]).toBe('/d');
    expect(invocation.args[1]).toBe('/s');
    expect(invocation.args[2]).toBe('/c');
    expect(invocation.args[3]).toContain('npm.cmd');
    expect(invocation.args[3]).toContain('pack');
  });

  it('uses node + npm-cli.js when npm_execpath points at npm-cli.js', () => {
    const invocation = resolveNpmCommandInvocation(['pack', '--silent'], {
      platform: 'win32',
      processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    });

    expect(invocation).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'pack', '--silent'],
    });
  });
});
