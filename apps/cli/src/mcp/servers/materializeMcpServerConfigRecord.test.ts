import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  McpServersSettingsV1Schema,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  resolveEffectiveServersV1,
} from '@happier-dev/protocol';

import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeEntrypoint } from '@/runtime/resolvePackagedRuntimeEntrypoint';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

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

  it('decrypts savedSecret env values using read-key fallbacks when legacy credentials read canonicalized settings', async () => {
    const recoverySecret = new Uint8Array(32).fill(6);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);
    const legacySettingsKey = deriveSettingsSecretsKeyV1(recoverySecret);
    const randomBytes = deterministicRandomBytesFactory();
    const enc = encryptSecretStringV1('sk-legacy', legacySettingsKey, randomBytes);

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
      settingsSecretsKey: canonicalSettingsKey,
      settingsSecretsReadKeys: [canonicalSettingsKey, legacySettingsKey],
      savedSecretsById: new Map([
        ['sec1', { _isSecretValue: true as const, encryptedValue: enc }],
      ]),
      processEnv: {},
      tmpDir: null,
    });

    expect(out.mcpServers.alpha.env).toEqual({ API_KEY: 'sk-legacy' });
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

  it('normalizes package-runner stdio servers through managed pnpm with a neutral launch cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-launcher-test-'));
    try {
      const fakePnpmPath = join(dir, 'pnpm');
      await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(fakePnpmPath, 0o755);
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
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
        processEnv: { HOME: '/safe-home', TOKEN: 'sk-test', HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: dir,
      });

      const cfg = out.mcpServers.alpha;
      expect(cfg.command).toBe(process.execPath);
      expect(cfg.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE).toBeTruthy();
      expect(cfg.env?.API_KEY).toBeUndefined();

      const distEntrypoint = join(projectPath(), 'dist', 'mcp', 'launchers', 'stdioMcpServerLauncher.mjs');
      const sourceEntrypoint = join(projectPath(), 'src', 'mcp', 'launchers', 'stdioMcpServerLauncher.ts');
      const tsxHookPath = resolveTsxImportHookPath();
      const packagedEntrypoint = resolvePackagedRuntimeEntrypoint('mcp/launchers/stdioMcpServerLauncher.mjs');
      const expectedArgs =
        !existsSync(distEntrypoint) && existsSync(sourceEntrypoint) && typeof tsxHookPath === 'string' && tsxHookPath.length > 0
          ? [
              '--no-warnings',
              '--no-deprecation',
              '--import',
              tsxHookPath,
              sourceEntrypoint,
            ]
          : ['--no-warnings', '--no-deprecation', packagedEntrypoint];
      expect(cfg.args).toEqual(expectedArgs);
      if (expectedArgs.includes('--import')) {
        expect(cfg.env?.TSX_TSCONFIG_PATH).toBe(resolveCliTsxTsconfigPath());
      } else {
        expect(cfg.env?.TSX_TSCONFIG_PATH).toBeUndefined();
      }

      const configPath = String(cfg.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain(`"command":"${fakePnpmPath}"`);
      expect(raw).toContain('"args":["dlx","@modelcontextprotocol/server-sequential-thinking"]');
      expect(raw).toContain('"cwd":"/safe-home"');
      expect(raw).toContain('"API_KEY":"sk-test"');
      expect(raw).not.toContain('happier-mcp-stdio-launcher.mjs');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves workspace cwd for package-manager run and exec stdio servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-workspace-cwd-test-'));
    try {
      const fakePnpmPath = join(dir, 'pnpm');
      await writeFile(fakePnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(fakePnpmPath, 0o755);
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'pnpm', args: ['exec', 'tsx', 'server.ts'] },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo/worktree' });
      const out = await materializeMcpServerConfigRecord({
        resolved,
        settingsSecretsKey: null,
        savedSecretsById: new Map(),
        processEnv: { HOME: '/safe-home', HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: dir,
      });

      const configPath = String(out.mcpServers.alpha.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE ?? '');
      const raw = await readFile(configPath, 'utf8');
      expect(raw).toContain(`"command":"${fakePnpmPath}"`);
      expect(raw).toContain('"args":["exec","tsx","server.ts"]');
      expect(raw).toContain('"cwd":"/repo/worktree"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips package-runner stdio servers when managed pnpm is unavailable in non-strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-unavailable-'));
    const originalFetch = globalThis.fetch;
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });
    try {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      const out = await materializeMcpServerConfigRecord({
        resolved,
        settingsSecretsKey: null,
        savedSecretsById: new Map(),
        processEnv: { PATH: '', HAPPIER_HOME_DIR: join(dir, 'home'), HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0' },
        tmpDir: null,
        strictMode: false,
      });

      expect(out.mcpServers).toEqual({});
      expect(out.warnings).toContainEqual({
        serverName: 'alpha',
        code: 'invalid_server',
        detail: 'managed pnpm unavailable for package-runner command',
      });
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed for package-runner stdio servers when managed pnpm is unavailable in strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-unavailable-strict-'));
    const originalFetch = globalThis.fetch;
    const settings = McpServersSettingsV1Schema.parse({
      v: 1,
      strictMode: true,
      servers: [
        {
          id: 's1',
          name: 'alpha',
          transport: 'stdio',
          stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
    });

    const resolved = resolveEffectiveServersV1(settings, { machineId: 'm1', directory: '/repo' });

    try {
      globalThis.fetch = async () => {
        throw new Error('offline');
      };

      await expect(
        materializeMcpServerConfigRecord({
          resolved,
          settingsSecretsKey: null,
          savedSecretsById: new Map(),
          processEnv: { PATH: '', HAPPIER_HOME_DIR: join(dir, 'home'), HAPPIER_MANAGED_PNPM_BOOTSTRAP: '0' },
          tmpDir: null,
          strictMode: true,
        }),
      ).rejects.toThrow(/managed pnpm unavailable/i);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
