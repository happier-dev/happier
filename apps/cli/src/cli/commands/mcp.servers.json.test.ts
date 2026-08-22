import { describe, expect, it, vi } from 'vitest';

import type { Credentials, TokenOnlyCredentials } from '@/persistence';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { accountSettingsParse, McpServersSettingsV1Schema, type AccountSettings } from '@happier-dev/protocol';

import { handleMcpCommand } from './mcp';
import type { McpCommandDeps } from './mcp/deps';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

function createCredentialsStub(): Credentials {
  return {
    token: 't',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  };
}

function createTokenOnlyCredentialsStub(): TokenOnlyCredentials {
  return {
    token: 'plain-token',
    encryption: null,
  };
}

function createAccountSettingsContextStub(args: Readonly<{
  mcpServersSettingsV1: unknown;
  secrets?: unknown;
  settingsVersion?: number;
  loadedAtMs?: number;
}>): AccountSettingsContext {
  return {
    source: 'network',
    settings: accountSettingsParse({
      schemaVersion: 2,
      mcpServersSettingsV1: args.mcpServersSettingsV1,
      ...(args.secrets === undefined ? {} : { secrets: args.secrets }),
    }),
    settingsVersion: args.settingsVersion ?? 10,
    loadedAtMs: args.loadedAtMs ?? 1,
    settingsSecretsReadKeys: [],
    whenRefreshed: null,
  };
}

type StoredAccountSettings = AccountSettings;
type JsonEnvelope = Readonly<{
  v: number;
  ok: boolean;
  kind: string;
  data?: Record<string, unknown>;
  error?: Readonly<{ code?: unknown; message?: unknown }>;
}>;

function createStoredAccountSettings(mcpServersSettingsV1: unknown): StoredAccountSettings {
  return accountSettingsParse({
    schemaVersion: 2,
    mcpServersSettingsV1,
  });
}

function applyMcpServersSettingsMutation(
  current: StoredAccountSettings,
  params: Parameters<McpCommandDeps['updateAccountSettingsV2WithRetry']>[0],
): StoredAccountSettings {
  if (!params.mutation) {
    throw new Error('Expected immutable MCP Settings mutation');
  }
  const [operation] = params.mutation.operations;
  if (
    params.mutation.operations.length !== 1
    || !operation
    || operation.op !== 'set'
    || operation.key !== 'mcpServersSettingsV1'
  ) {
    throw new Error('Expected one MCP Servers Settings set operation');
  }
  return accountSettingsParse({
    ...current,
    mcpServersSettingsV1: operation.value,
  });
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

async function runJsonMcpCommand(
  args: string[],
  deps: Partial<McpCommandDeps>,
): Promise<Readonly<{ parsed: JsonEnvelope; exitCode: number | undefined }>> {
  const output = captureConsoleLogAndMuteStdout();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await handleMcpCommand(args, deps);
    return {
      parsed: JSON.parse(output.logs.join('\n').trim()) as JsonEnvelope,
      exitCode: process.exitCode,
    };
  } finally {
    output.restore();
    process.exitCode = previousExitCode;
  }
}

describe.sequential('happier mcp servers --json', () => {
  it('prints a mcp_servers_list JSON envelope', async () => {
    const bootstrapCalls: unknown[] = [];
    const mcpSettings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'bind-1',
          serverId: 'srv-1',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const { parsed, exitCode } = await runJsonMcpCommand(['servers', 'list', '--json'], {
      readStoredCredentials: async () => createTokenOnlyCredentialsStub(),
      bootstrapAccountSettingsContext: async (args: unknown) => {
        bootstrapCalls.push(args);
        return createAccountSettingsContextStub({ mcpServersSettingsV1: mcpSettings });
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.v).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_list');
    const data = readObject(parsed.data);
    expect(data?.strictMode).toBe(false);
    expect(Array.isArray(data?.servers)).toBe(true);
    expect(data?.servers).toEqual([
      expect.objectContaining({ id: 'srv-1', name: 'example', transport: 'stdio', bindingCount: 1 }),
    ]);
    expect(bootstrapCalls).toEqual([
      expect.objectContaining({ mode: 'blocking', refresh: 'force' }),
    ]);
    expect(exitCode).toBe(0);
  });

  it('prints a mcp_servers_add JSON envelope and adds a stdio server', async () => {
    let storedSettings = createStoredAccountSettings(McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [],
      bindings: [],
    }));

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'add',
      '--name',
      'example',
      '--transport',
      'stdio',
      '--command',
      'node',
      '--arg',
      'server.js',
      '--json',
    ], {
      readStoredCredentials: async () => createTokenOnlyCredentialsStub(),
      randomUUID: () => 'srv-1',
      nowMs: () => 123,
      updateAccountSettingsV2WithRetry: async (params) => {
        storedSettings = applyMcpServersSettingsMutation(storedSettings, params);
        return { status: 'applied' as const, version: 11, settings: storedSettings };
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_add');
    const data = readObject(parsed.data);
    const created = readObject(data?.created);
    expect(created?.id).toBe('srv-1');
    expect(created?.name).toBe('example');

    const next = McpServersSettingsV1Schema.parse(storedSettings.mcpServersSettingsV1);
    expect(next.servers).toHaveLength(1);
    expect(next.servers[0]).toMatchObject({
      id: 'srv-1',
      name: 'example',
      transport: 'stdio',
      stdio: { command: 'node', args: ['server.js'] },
    });
    expect(exitCode).toBe(0);
  });

  it('preserves a failed MCP Settings mutation as a redacted JSON settlement', async () => {
    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'add',
      '--name',
      'example',
      '--transport',
      'stdio',
      '--command',
      'node',
      '--json',
    ], {
      readStoredCredentials: async () => createTokenOnlyCredentialsStub(),
      updateAccountSettingsV2WithRetry: async () => ({
        status: 'conflict' as const,
        currentVersion: 17,
      }),
    } satisfies Partial<McpCommandDeps>);

    expect(parsed).toMatchObject({
      ok: false,
      kind: 'mcp_servers_add',
      error: { code: 'account_settings_conflict' },
    });
    expect(readObject(parsed.error)?.settlement).toEqual({
      status: 'conflict',
      currentVersion: 17,
    });
    expect(exitCode).toBe(1);
  });

  it('prints a mcp_servers_bind JSON envelope and creates a binding', async () => {
    let storedSettings = createStoredAccountSettings(McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [],
    }));

    const ids = ['bind-1'];

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'bind',
      '--mcp-server',
      'example',
      '--all-machines',
      '--json',
    ], {
      readStoredCredentials: async () => createCredentialsStub(),
      randomUUID: () => ids.shift() ?? 'bind-fallback',
      nowMs: () => 456,
      updateAccountSettingsV2WithRetry: async (params) => {
        storedSettings = applyMcpServersSettingsMutation(storedSettings, params);
        return { status: 'applied' as const, version: 12, settings: storedSettings };
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_bind');
    const data = readObject(parsed.data);
    expect(data?.createdBindingId).toBe('bind-1');

    const next = McpServersSettingsV1Schema.parse(storedSettings.mcpServersSettingsV1);
    expect(next.bindings).toHaveLength(1);
    expect(next.bindings[0]).toMatchObject({
      id: 'bind-1',
      serverId: 'srv-1',
      enabled: true,
      target: { t: 'allMachines' },
    });
    expect(exitCode).toBe(0);
  });

  it('accepts legacy --server flag for bind (alias for --mcp-server)', async () => {
    let storedSettings = createStoredAccountSettings(McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [],
    }));

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'bind',
      '--server',
      'example',
      '--all-machines',
      '--json',
    ], {
      readStoredCredentials: async () => createCredentialsStub(),
      randomUUID: () => 'bind-legacy-1',
      nowMs: () => 456,
      updateAccountSettingsV2WithRetry: async (params) => {
        storedSettings = applyMcpServersSettingsMutation(storedSettings, params);
        return { status: 'applied' as const, version: 12, settings: storedSettings };
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_bind');

    const next = McpServersSettingsV1Schema.parse(storedSettings.mcpServersSettingsV1);
    expect(next.bindings).toHaveLength(1);
    expect(next.bindings[0]).toMatchObject({
      id: 'bind-legacy-1',
      serverId: 'srv-1',
      enabled: true,
      target: { t: 'allMachines' },
    });
    expect(exitCode).toBe(0);
  });

  it('prints an expected JSON error when binding a missing MCP server', async () => {
    let storedSettings = createStoredAccountSettings(McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [],
      bindings: [],
    }));

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'bind',
      '--mcp-server',
      'missing',
      '--all-machines',
      '--json',
    ], {
      readStoredCredentials: async () => createCredentialsStub(),
      updateAccountSettingsV2WithRetry: async (params) => {
        storedSettings = applyMcpServersSettingsMutation(storedSettings, params);
        return { status: 'applied' as const, version: 12, settings: storedSettings };
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('mcp_servers_bind');
    expect(parsed.error?.code).toBe('invalid_arguments');
    expect(String(parsed.error?.message ?? '')).toContain('MCP server not found');
    expect(McpServersSettingsV1Schema.parse(storedSettings.mcpServersSettingsV1).bindings).toHaveLength(0);
    expect(exitCode).toBe(1);
  });


  it('prints a mcp_servers_unbind JSON envelope and removes a binding', async () => {
    let storedSettings = createStoredAccountSettings(McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'bind-1',
          serverId: 'srv-1',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }));

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'unbind',
      '--binding-id',
      'bind-1',
      '--json',
    ], {
      readStoredCredentials: async () => createCredentialsStub(),
      updateAccountSettingsV2WithRetry: async (params) => {
        storedSettings = applyMcpServersSettingsMutation(storedSettings, params);
        return { status: 'applied' as const, version: 13, settings: storedSettings };
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_unbind');
    const data = readObject(parsed.data);
    expect(data?.removedBindingId).toBe('bind-1');

    const next = McpServersSettingsV1Schema.parse(storedSettings.mcpServersSettingsV1);
    expect(next.bindings).toHaveLength(0);
    expect(exitCode).toBe(0);
  });

  it('prints an expected JSON error when unbinding a missing MCP binding', async () => {
    let storedSettings = createStoredAccountSettings(McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [],
      bindings: [],
    }));

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'unbind',
      '--binding-id',
      'missing-binding',
      '--json',
    ], {
      readStoredCredentials: async () => createCredentialsStub(),
      updateAccountSettingsV2WithRetry: async (params) => {
        storedSettings = applyMcpServersSettingsMutation(storedSettings, params);
        return { status: 'applied' as const, version: 13, settings: storedSettings };
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('mcp_servers_unbind');
    expect(parsed.error?.code).toBe('invalid_arguments');
    expect(String(parsed.error?.message ?? '')).toContain('Binding not found');
    expect(McpServersSettingsV1Schema.parse(storedSettings.mcpServersSettingsV1).bindings).toHaveLength(0);
    expect(exitCode).toBe(1);
  });


  it('prints a mcp_servers_detect JSON envelope', async () => {
    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'detect',
      '--provider',
      'claude',
      '--json',
    ], {
      detectProviderMcpServers: async () => ({
        servers: [
          {
            provider: 'claude',
            name: 'claude-detected',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
            envKeys: ['API_KEY'],
            enabled: true,
            source: { kind: 'user', path: '/tmp/claude.json' },
          },
        ],
        warnings: [],
      }),
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_detect');
    const data = readObject(parsed.data);
    expect(data?.servers).toEqual([
      expect.objectContaining({ provider: 'claude', name: 'claude-detected', transport: 'stdio' }),
    ]);
    expect(exitCode).toBe(0);
  });

  it('prints a mcp_servers_test JSON envelope', async () => {
    const bootstrapCalls: unknown[] = [];
    const commandEnv = {
      WAVE31_MCP_TOKEN: 'from-deps-env',
    } satisfies NodeJS.ProcessEnv;
    let capturedProbeBaseEnv: NodeJS.ProcessEnv | null = null;
    let capturedProbeConfigEnv: Record<string, string> | undefined;
    const mcpSettings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'plain-secret' } },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'bind-1',
          serverId: 'srv-1',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'test',
      '--mcp-server',
      'example',
      '--dir',
      '/tmp',
      '--json',
    ], {
      readStoredCredentials: async () => createTokenOnlyCredentialsStub(),
      env: commandEnv,
      ensureMachineIdForCredentials: async () => ({ machineId: 'machine-1' }),
      bootstrapAccountSettingsContext: async (args: unknown) => {
        bootstrapCalls.push(args);
        return createAccountSettingsContextStub({
          mcpServersSettingsV1: mcpSettings,
          secrets: [
            {
              id: 'plain-secret',
              name: 'Plain secret',
              encryptedValue: {
                _isSecretValue: true,
                value: 'plain-secret-value',
              },
            },
          ],
        });
      },
      probeMcpStdioServerTools: async (params) => {
        capturedProbeBaseEnv = params.baseEnv ?? null;
        capturedProbeConfigEnv = params.config.env;
        return [{ name: 'tool-a' }, { name: 'tool-b' }];
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('mcp_servers_test');
    const data = readObject(parsed.data);
    expect(data?.toolCount).toBe(2);
    expect(data?.toolNamesSample).toEqual(['tool-a', 'tool-b']);
    expect(typeof data?.durationMs).toBe('number');
    expect(bootstrapCalls).toEqual([
      expect.objectContaining({ mode: 'blocking', refresh: 'force' }),
    ]);
    expect(capturedProbeBaseEnv).toBe(commandEnv);
    expect(capturedProbeConfigEnv).toEqual({ API_KEY: 'plain-secret-value' });
    expect(exitCode).toBe(0);
  });

  it('does not probe a retained encrypted Settings secret with token-only credentials', async () => {
    const probeMcpStdioServerTools = vi.fn(async () => [{ name: 'unexpected-tool' }]);
    const mcpSettings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'retained-secret' } },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'bind-1',
          serverId: 'srv-1',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'test',
      '--mcp-server',
      'example',
      '--dir',
      '/tmp',
      '--json',
    ], {
      readStoredCredentials: async () => createTokenOnlyCredentialsStub(),
      ensureMachineIdForCredentials: async () => ({ machineId: 'machine-1' }),
      bootstrapAccountSettingsContext: async () => createAccountSettingsContextStub({
        mcpServersSettingsV1: mcpSettings,
        secrets: [
          {
            id: 'retained-secret',
            name: 'Retained encrypted secret',
            encryptedValue: {
              _isSecretValue: true,
              encryptedValue: {
                t: 'enc-v1',
                c: 'AAAA',
              },
            },
          },
        ],
      }),
      probeMcpStdioServerTools,
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('mcp_servers_test');
    expect(parsed.error?.code).toBe('mcp_test_failed');
    expect(probeMcpStdioServerTools).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it('redacts sensitive probe failures in the mcp_servers_test JSON envelope', async () => {
    const mcpSettings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [
        {
          id: 'srv-1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      bindings: [
        {
          id: 'bind-1',
          serverId: 'srv-1',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const { parsed, exitCode } = await runJsonMcpCommand([
      'servers',
      'test',
      '--mcp-server',
      'example',
      '--dir',
      '/tmp',
      '--json',
    ], {
      readStoredCredentials: async () => createCredentialsStub(),
      ensureMachineIdForCredentials: async () => ({ machineId: 'machine-1' }),
      bootstrapAccountSettingsContext: async () => createAccountSettingsContextStub({ mcpServersSettingsV1: mcpSettings }),
      probeMcpStdioServerTools: async () => {
        throw new Error('Authorization: Bearer abc/def+ghi==');
      },
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('mcp_servers_test');
    expect(String(parsed.error?.message ?? '')).not.toContain('abc/def');
    expect(String(parsed.error?.message ?? '')).toContain('[REDACTED]');
    expect(exitCode).toBe(1);
  });

  it('prints a stable JSON error envelope for unknown groups', async () => {
    const { parsed, exitCode } = await runJsonMcpCommand(['wat', '--json'], {
      readStoredCredentials: async () => createCredentialsStub(),
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('mcp_unknown');
    expect(parsed.error?.code).toBeTruthy();
    expect(exitCode).toBe(1);
  });

  it('prints a stable JSON error envelope for unknown servers subcommands', async () => {
    const { parsed, exitCode } = await runJsonMcpCommand(['servers', 'wat', '--json'], {
      readStoredCredentials: async () => createCredentialsStub(),
    } satisfies Partial<McpCommandDeps>);

    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('mcp_servers_wat');
    expect(parsed.error?.code).toBeTruthy();
    expect(exitCode).toBe(1);
  });
});
