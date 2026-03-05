import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  McpServersSettingsV1Schema,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  resolveEffectiveServersV1,
} from '@happier-dev/protocol';

import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('materializeMcpServerConfigRecord', () => {
  it('materializes stdio servers and expands env templates', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { API_KEY: { t: 'literal', v: '${TOKEN}' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      settingsSecretsKey: null,
      savedSecretsById: new Map(),
      processEnv: { TOKEN: 'sk-test' },
      tmpDir: null,
    });

    expect(out.mcpServers.alpha.command).toBe('node');
    expect(out.mcpServers.alpha.args).toEqual(['server.js']);
    expect(out.mcpServers.alpha.env).toEqual({ API_KEY: 'sk-test' });
  });

  it('decrypts savedSecret env values using the settings secrets key', async () => {
    const masterSecret = new Uint8Array(32).fill(9);
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(masterSecret);
    const randomBytes = deterministicRandomBytesFactory();
    const enc = encryptSecretStringV1('sk-real', settingsSecretsKey, randomBytes);

    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'sec1' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });
    const out = await materializeMcpServerConfigRecord({
      resolved,
      settingsSecretsKey,
      savedSecretsById: new Map([
        ['sec1', { _isSecretValue: true as const, encryptedValue: enc }],
      ]),
      processEnv: {},
      tmpDir: null,
    });

    expect(out.mcpServers.alpha.env).toEqual({ API_KEY: 'sk-real' });
  });

  it('skips invalid servers when strictMode=false and throws when strictMode=true', async () => {
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: { API_KEY: { t: 'savedSecret', secretId: 'missing' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });

    const nonStrict = await materializeMcpServerConfigRecord({
      resolved,
      settingsSecretsKey: new Uint8Array(32).fill(1),
      savedSecretsById: new Map(),
      processEnv: {},
      tmpDir: null,
      strictMode: false,
    });
    expect(nonStrict.mcpServers).toEqual({});
    expect(nonStrict.warnings.length).toBeGreaterThan(0);

    await expect(
      materializeMcpServerConfigRecord({
        resolved,
        settingsSecretsKey: new Uint8Array(32).fill(1),
        savedSecretsById: new Map(),
        processEnv: {},
        tmpDir: null,
        strictMode: true,
      }),
    ).rejects.toThrow(/missing/i);
  });

  it('materializes remote servers via a stdio bridge config file (no secrets in argv)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-remote-test-'));
    try {
      const masterSecret = new Uint8Array(32).fill(4);
      const settingsSecretsKey = deriveSettingsSecretsKeyV1(masterSecret);
      const randomBytes = deterministicRandomBytesFactory();
      const enc = encryptSecretStringV1('Bearer SECRET', settingsSecretsKey, randomBytes);

      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'http',
            remote: { url: 'https://mcp.example.com', headers: { Authorization: { t: 'savedSecret', secretId: 'sec1' } } },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        settingsSecretsKey,
        savedSecretsById: new Map([
          ['sec1', { _isSecretValue: true as const, encryptedValue: enc }],
        ]),
        processEnv: {},
        tmpDir: dir,
        deps: {
          resolveRemoteBridgeCommand: () => ({ command: 'node', args: ['bridge.js'] }),
        },
      });

      const cfg = out.mcpServers.alpha;
      expect(cfg.command).toBe('node');
      expect(cfg.args).toEqual(['bridge.js']);
      expect(cfg.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE).toBeTruthy();

      const argvJoined = (cfg.args ?? []).join(' ');
      expect(argvJoined).not.toContain('SECRET');

      const configPath = String(cfg.env?.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain('mcp.example.com');
      expect(raw).toContain('Bearer SECRET');

      const st = await stat(configPath);
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

