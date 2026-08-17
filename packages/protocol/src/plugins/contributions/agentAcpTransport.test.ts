import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ManagedExecutableRefSchema,
  PluginAgentAcpTransportSchema,
  PluginHostAccessRequestV2Schema,
  PluginMcpServerTransportV1Schema,
  type ManagedExecutableRef,
  type PluginAgentAcpTransport,
} from '../../index.js';

describe('plugin agent ACP transport contract', () => {
  it('accepts only the canonical closed transport variants', () => {
    const executable = {
      kind: 'managedDependency',
      id: 'codex-cli',
    } satisfies ManagedExecutableRef;
    const transport = {
      kind: 'stdio',
      executable,
      preferredPath: '/opt/acme/codex',
      args: ['app-server'],
      env: { CODEX_HOME: '/plugin-data/codex' },
      timeouts: { initializeMs: 10_000, idleMs: 60_000, toolCallMs: 120_000 },
    } satisfies PluginAgentAcpTransport;

    expect(ManagedExecutableRefSchema.parse(executable)).toEqual(executable);
    expect(PluginAgentAcpTransportSchema.parse(transport)).toEqual(transport);
    expect(PluginAgentAcpTransportSchema.safeParse({
      kind: 'webSocket',
      url: 'wss://127.0.0.1/acp',
      headers: { 'x-session': 'session-1' },
      timeouts: { initializeMs: 1 },
    }).success).toBe(true);
    expect(PluginAgentAcpTransportSchema.safeParse({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 65_535,
    }).success).toBe(true);

    expectTypeOf(transport).toMatchTypeOf<PluginAgentAcpTransport>();
    expectTypeOf<Extract<PluginAgentAcpTransport, { kind: 'stdio' }>['args']>()
      .toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<Extract<PluginAgentAcpTransport, { kind: 'stdio' }>['preferredPath']>()
      .toEqualTypeOf<string | undefined>();
  });

  it('accepts the logical packaged-runtime binary ref without exposing a host path', () => {
    const executable = {
      kind: 'packaged-runtime-binary',
      directorySegments: ['tools', 'unpacked'],
      executableBaseName: 'happier-cliproxyapi-managed',
    } as const satisfies ManagedExecutableRef;

    expect(ManagedExecutableRefSchema.parse(executable)).toEqual(executable);
    expect(ManagedExecutableRefSchema.safeParse({
      ...executable,
      executablePath: '/opt/happier/tools/unpacked/happier-cliproxyapi-managed',
    }).success).toBe(false);
    expect(PluginAgentAcpTransportSchema.safeParse({
      kind: 'stdio',
      executable,
    }).success).toBe(false);
    expect(PluginMcpServerTransportV1Schema.safeParse({
      kind: 'stdio',
      executable,
    }).success).toBe(false);
    expect(PluginHostAccessRequestV2Schema.safeParse({
      id: 'claim-packaged-runtime',
      capability: 'process',
      reason: 'Try to claim Provider-only packaged authority',
      scope: { executables: [executable] },
    }).success).toBe(false);
  });

  it('rejects unknown and retired transport shapes instead of preserving a second ABI', () => {
    for (const candidate of [
      { kind: 'managedDependency', id: 'codex-cli', path: '/usr/bin/codex' },
      { kind: 'stdio', executable: { kind: 'managedDependency', id: 'codex-cli' }, shell: true },
      { kind: 'stdio', launch: { kind: 'executable', command: 'codex' } },
      { kind: 'ws', url: 'ws://127.0.0.1/acp' },
      { kind: 'webSocket', url: 'ws://127.0.0.1/acp', headers: {}, reconnectMs: 1 },
      { kind: 'tcp', host: '127.0.0.1', port: 1234, timeouts: { promptMs: 1 } },
    ]) {
      const schema = 'id' in candidate && candidate.kind === 'managedDependency'
        ? ManagedExecutableRefSchema
        : PluginAgentAcpTransportSchema;
      expect(schema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });

  it('rejects structurally impossible values without inventing field-local manifest budgets', () => {
    const largeExecutable = {
      kind: 'systemTool',
      id: 'large-system-tool',
    } as const;
    const largeArgs = Array.from(
      { length: 300 },
      () => 'x'.repeat(17 * 1024),
    );
    const largeEnv = Object.fromEntries(Array.from(
      { length: 150 },
      (_, index) => [`ENV_${index}`, 'x'.repeat(17 * 1024)],
    ));
    const largeHeaders = Object.fromEntries(Array.from(
      { length: 150 },
      (_, index) => [`x-header-${index}`, 'x'.repeat(17 * 1024)],
    ));

    expect(PluginAgentAcpTransportSchema.safeParse({
      kind: 'stdio',
      executable: largeExecutable,
      args: largeArgs,
      env: largeEnv,
      timeouts: { initializeMs: 2_147_483_647 },
    }).success).toBe(true);
    expect(PluginAgentAcpTransportSchema.safeParse({
      kind: 'webSocket',
      url: `ws://localhost/${'x'.repeat(9 * 1024)}`,
      headers: largeHeaders,
    }).success).toBe(true);

    for (const candidate of [
      {
        kind: 'stdio',
        executable: {
          kind: 'literal',
          command: 'account-configured-acp',
        },
      },
      { kind: 'stdio', executable: largeExecutable, env: { ' PADDED ': 'x' } },
      { kind: 'stdio', executable: largeExecutable, preferredPath: '   ' },
      { kind: 'stdio', executable: largeExecutable, preferredPath: '/opt/contains\0nul' },
      { kind: 'stdio', executable: largeExecutable, args: ['contains\0nul'] },
      { kind: 'stdio', executable: largeExecutable, env: { 'ENV\0KEY': 'x' } },
      { kind: 'stdio', executable: largeExecutable, env: { ENV_KEY: 'contains\0nul' } },
      { kind: 'webSocket', url: 'file:///tmp/acp.sock' },
      { kind: 'webSocket', url: 'ws://localhost', headers: { ' x-header ': 'x' } },
      { kind: 'webSocket', url: 'ws://localhost', headers: { 'invalid header': 'x' } },
      { kind: 'webSocket', url: 'ws://localhost', headers: { 'x-header': 'ok\r\ninjected: yes' } },
      { kind: 'tcp', host: '', port: 1234 },
      { kind: 'tcp', host: '127.0.0.1', port: 0 },
      { kind: 'tcp', host: '127.0.0.1', port: 65_536 },
      { kind: 'tcp', host: '127.0.0.1', port: 1234, timeouts: { idleMs: 0 } },
      {
        kind: 'tcp',
        host: '127.0.0.1',
        port: 1234,
        timeouts: { toolCallMs: 2_147_483_648 },
      },
    ]) {
      expect(PluginAgentAcpTransportSchema.safeParse(candidate).success, JSON.stringify(candidate)).toBe(false);
    }
  });
});
