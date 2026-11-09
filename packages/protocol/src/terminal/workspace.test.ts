import { describe, expect, it } from 'vitest';
import { SessionTerminalTargetV1Schema } from './workspace';

describe('session terminal target ownership', () => {
  it('keeps service-shell native selection at the Machine terminal owner', () => {
    const launch = { kind: 'service_shell', serviceId: 'instance/app', expectedGeneration: 'generation-a' };
    expect(SessionTerminalTargetV1Schema.safeParse({ kind: 'workspace_shell', launch }).success).toBe(false);
    expect(SessionTerminalTargetV1Schema.safeParse({ kind: 'machine_shell', machineId: 'machine', cwd: '/caller', launch }).success).toBe(false);
  });

  it('keeps a borrowed checkout on its actual Machine and preserves the accepted root separately from cwd', () => {
    const workspace = { serverId: 'home', workspaceId: 'worker-checkout', machineId: 'worker', rootPath: '/worker' };
    const target = { kind: 'terminal_view', machineId: 'worker', terminalId: 'pty', terminalKey: 'output',
      cwd: '/worker/packages/check', workspace };
    expect(SessionTerminalTargetV1Schema.parse(target)).toEqual(target);
    expect(SessionTerminalTargetV1Schema.safeParse({ ...target, machineId: 'source' }).success).toBe(false);
    expect(SessionTerminalTargetV1Schema.safeParse({ ...target, workspace: { ...workspace, trusted: true } }).success).toBe(false);
  });
  it('requires the dedicated attached target instead of smuggling an agent attachment into an owned shell', () => {
    expect(SessionTerminalTargetV1Schema.safeParse({ kind: 'workspace_shell', launch: { kind: 'session_attach', sessionId: 'other-session' } }).success).toBe(false);
    expect(SessionTerminalTargetV1Schema.safeParse({ kind: 'session_attach' }).success).toBe(true);
  });
});
