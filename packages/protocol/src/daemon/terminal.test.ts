import { describe, expect, it } from 'vitest';

import { DaemonTerminalEnsureRequestSchema, DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema } from './terminal';
import { MachineTerminalOpenInputSchema } from '../actions/specs/machineTerminal';

describe('daemon terminal listing V1', () => {
  it('admits the read-only projection and rejects unknown authority or process fields', () => {
    expect(DaemonTerminalListRequestV1Schema.parse({})).toEqual({});
    expect(DaemonTerminalListRequestV1Schema.safeParse({ sessionId: 'other' }).success).toBe(false);
    const terminal = { terminalId: 't', terminalKey: 'shell', cwd: '/repo', ended: true, exit: { exitCode: 1, signal: null } };
    expect(DaemonTerminalListResponseV1Schema.parse({ ok: true, terminals: [terminal] })).toEqual({ ok: true, terminals: [terminal] });
    const warning = { v: 1, kind: 'stopping', stopAt: 300_000, rule: 'idle_terminals' };
    expect(DaemonTerminalListResponseV1Schema.parse({ ok: true, terminals: [{ ...terminal, terminalGuardStateV1: warning }] }))
      .toEqual({ ok: true, terminals: [{ ...terminal, terminalGuardStateV1: warning }] });
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: true, terminals: [{ ...terminal,
      terminalGuardStateV1: { ...warning, sessionId: 'unrelated-session' } }] }).success).toBe(false);
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: true, terminals: [{ ...terminal, env: { TOKEN: 'secret' } }] }).success).toBe(false);
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: true, terminals: [{ ...terminal, exit: { exitCode: 1, signal: null, detail: 'secret' } }] }).success).toBe(false);
    expect(DaemonTerminalListResponseV1Schema.safeParse({ ok: false, errorCode: 'terminal_disabled', error: 'disabled', extra: true }).success).toBe(false);
  });
});

describe('DaemonTerminalEnsureRequestSchema', () => {
  it('admits only an exact daemon-resolved service shell through both terminal front doors', () => {
    const request = { terminalKey: 'service:app', launch: {
      kind: 'service_shell', serviceId: 'environment-instance/app', expectedGeneration: 'generation-a',
    } };
    expect(DaemonTerminalEnsureRequestSchema.parse(request)).toEqual(request);
    const action = { ...request, serverId: 'home', machineId: 'machine' };
    expect(MachineTerminalOpenInputSchema.parse(action)).toEqual(action);
    for (const extra of [{ cwd: '/caller' }, { workspace: { serverId: 'home', machineId: 'machine', rootPath: '/caller' } },
      { sessionId: 'caller-session' }, { initialCommand: 'docker compose exec foreign sh' }]) {
      expect(DaemonTerminalEnsureRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
      expect(MachineTerminalOpenInputSchema.safeParse({ ...action, ...extra }).success).toBe(false);
    }
    for (const launch of [{ ...request.launch, expectedGeneration: '' }, { ...request.launch, command: 'sh' },
      { kind: 'service_shell', target: { kind: 'candidate', deploymentId: 'candidate-b', service: 'app' } }]) {
      expect(DaemonTerminalEnsureRequestSchema.safeParse({ ...request, launch }).success).toBe(false);
      expect(MachineTerminalOpenInputSchema.safeParse({ ...action, launch }).success).toBe(false);
    }
  });

  it('carries an optional Compose member selector for a project-level watched service shell', () => {
    const request = { terminalKey: 'service:watched', launch: {
      kind: 'service_shell', serviceId: 'watch-a', expectedGeneration: 'generation-a', service: 'web',
    } };
    expect(DaemonTerminalEnsureRequestSchema.parse(request)).toEqual(request);
    const action = { ...request, serverId: 'home', machineId: 'machine' };
    expect(MachineTerminalOpenInputSchema.parse(action)).toEqual(action);
    const empty = { ...request, launch: { ...request.launch, service: '' } };
    expect(DaemonTerminalEnsureRequestSchema.safeParse(empty).success).toBe(false);
  });

  it('normalizes the 0.2 startup command into the one typed launch at the parse boundary', () => {
    const legacy = {
      terminalKey: 'service-shell', initialCommand: 'docker compose exec app sh',
    };
    const canonical = { terminalKey: legacy.terminalKey,
      launch: { kind: 'shell_command', command: legacy.initialCommand } };
    expect(DaemonTerminalEnsureRequestSchema.parse(legacy)).toEqual(canonical);
    expect(DaemonTerminalEnsureRequestSchema.parse(canonical)).toEqual(canonical);
    expect(MachineTerminalOpenInputSchema.parse({ ...legacy, serverId: 'home', machineId: 'machine' }))
      .toEqual({ ...canonical, serverId: 'home', machineId: 'machine' });
    expect(DaemonTerminalEnsureRequestSchema.safeParse({ ...legacy, authority: 'present_user' }).success).toBe(false);
  });

  it('accepts a typed attached-session action and rejects a competing raw command', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'session:dialog-attach',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    })).toMatchObject({
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    });

    expect(DaemonTerminalEnsureRequestSchema.safeParse({
      terminalKey: 'session:dialog-attach',
      initialCommand: 'happier attach session-1',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    }).success).toBe(false);
  });

  it('accepts a bounded first-party Happier CLI launch', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'provider-login:machine-1:antigravity',
      launch: { kind: 'happier_cli', args: ['agents', 'auth', 'login', 'antigravity'] },
    })).toMatchObject({
      launch: { kind: 'happier_cli', args: ['agents', 'auth', 'login', 'antigravity'] },
    });
  });
  it('accepts an optional sessionId attribution field', () => {
    const parsed = DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'terminal-a',
      cwd: '/repo/web',
      sessionId: 'session-a',
    });

    expect(parsed.sessionId).toBe('session-a');
  });

  it('omits sessionId when not supplied (back-compatible)', () => {
    const parsed = DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'terminal-a',
      cwd: '/repo/web',
    });

    expect(parsed.sessionId).toBeUndefined();
  });

  it('rejects an empty sessionId', () => {
    const result = DaemonTerminalEnsureRequestSchema.safeParse({
      terminalKey: 'terminal-a',
      sessionId: '',
    });

    expect(result.success).toBe(false);
  });
});
