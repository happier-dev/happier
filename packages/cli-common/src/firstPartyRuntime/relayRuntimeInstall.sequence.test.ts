import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from './relayRuntimeInstall.js';

const serviceActions = vi.hoisted(() => [] as string[]);
const serviceEvents = vi.hoisted(() => [] as string[]);
const serviceSnapshots = vi.hoisted(() => [] as Array<{
  binary: string;
  generated: string;
  prismaEngine: string;
}>);
const serviceSpecs = vi.hoisted(() => [] as Array<{
  env: Readonly<Record<string, string>>;
}>);
const checkRelayRuntimeHealthMock = vi.hoisted(() => vi.fn(async () => ({
  reachable: true,
  url: 'http://127.0.0.1:4010',
})));

vi.mock('../service/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../service/index.js')>();

  return {
    ...actual,
    resolveServiceBackend: vi.fn(() => 'systemd-user'),
    buildServiceDefinition: vi.fn((params: { spec?: { env?: Record<string, string> } }) => {
      serviceSpecs.push({ env: { ...(params.spec?.env ?? {}) } });
      return {
        path: '/tmp/happier-relay-runtime.service',
        contents: '[Service]\n',
      };
    }),
    planServiceAction: vi.fn((params: { action: string; label?: string }) => ({
      __action: params.action,
      __label: String(params.label ?? ''),
      writes: [],
      commands: [],
    })),
    applyServicePlan: vi.fn(async (plan: { __action?: string; __label?: string }) => {
      const action = String(plan?.__action ?? 'unknown');
      serviceActions.push(action);
      serviceEvents.push(`${action}:${String(plan?.__label ?? '')}`);
    }),
  };
});

vi.mock('./relayRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./relayRuntime.js')>();

  return {
    ...actual,
    checkRelayRuntimeHealth: checkRelayRuntimeHealthMock,
  };
});

describe('installOrUpdateRelayRuntimeLocal sequencing', () => {
  beforeEach(async () => {
    serviceActions.length = 0;
    serviceEvents.length = 0;
    serviceSnapshots.length = 0;
    serviceSpecs.length = 0;
    const serviceModule = await import('../service/index.js');
    vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
      const action = String((plan as { __action?: string }).__action ?? 'unknown');
      serviceActions.push(action);
      serviceEvents.push(`${action}:${String((plan as { __label?: string }).__label ?? '')}`);
    });
    checkRelayRuntimeHealthMock.mockImplementation(async () => {
      const activationSpec = [...serviceSpecs].reverse().find((spec) => (
        typeof spec.env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH === 'string'
        && typeof spec.env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE === 'string'
      ));
      if (activationSpec) {
        const receiptPath = activationSpec.env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH;
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(receiptPath, JSON.stringify({
          nonce: activationSpec.env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE,
          pid: process.pid,
        }), 'utf8');
      }
      return {
        reachable: true,
        url: 'http://127.0.0.1:4010',
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    checkRelayRuntimeHealthMock.mockReset();
    checkRelayRuntimeHealthMock.mockResolvedValue({
      reachable: true,
      url: 'http://127.0.0.1:4010',
    });
  });

  it('commits install state only after candidate health and private startup attestation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-commit-order-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      await mkdir(join(payloadRoot, 'ui-web', 'current'), { recursive: true });
      await writeFile(join(payloadRoot, 'ui-web', 'current', 'index.html'), '<script src="/assets/index-a.js"></script>\n', 'utf8');
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const statePath = join(defaults.installRoot, 'self-host-state.json');
      await mkdir(defaults.installRoot, { recursive: true });
      await writeFile(statePath, JSON.stringify({ version: '0.1.2' }), 'utf8');
      checkRelayRuntimeHealthMock.mockImplementationOnce(async () => {
        await expect(readFile(statePath, 'utf8')).resolves.toContain('0.1.2');
        const activationSpec = [...serviceSpecs].reverse().find((spec) => (
          spec.env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH
          && spec.env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE
        ));
        expect(activationSpec).toBeDefined();
        if (activationSpec) {
          await mkdir(dirname(activationSpec.env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH), { recursive: true });
          await writeFile(
            activationSpec.env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH,
            JSON.stringify({
              nonce: activationSpec.env.HAPPIER_SERVER_STARTUP_RECEIPT_NONCE,
              pid: process.pid,
            }),
            'utf8',
          );
        }
        return { reachable: true, url: 'http://127.0.0.1:4010' };
      });

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        version: '0.2.0',
        runServiceCommands: true,
      });

      const committedState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      expect(committedState.version).toBe('0.2.0');
      expect(committedState.uiDeploymentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(committedState.uiDeploymentId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(serviceSpecs.at(-1)?.env.HAPPIER_SERVER_UI_DEPLOYMENT_ID).toBe(committedState.uiDeploymentId);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('stops the existing relay service before replacing the persistent runtime payload', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-sequence-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      const installServerBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      await mkdir(join(dirname(installServerBinaryPath), 'generated'), { recursive: true });
      await mkdir(join(dirname(installServerBinaryPath), 'node_modules', '.prisma', 'client'), { recursive: true });
      await mkdir(join(dirname(installServerBinaryPath), 'node_modules', '@prisma', 'client'), { recursive: true });
      await writeFile(installServerBinaryPath, '#!/bin/sh\necho old-runtime\n', 'utf8');
      await writeFile(join(dirname(installServerBinaryPath), 'generated', 'dummy.txt'), 'old-generated', 'utf8');
      await writeFile(join(dirname(installServerBinaryPath), 'node_modules', '.prisma', 'client', 'query_engine.so'), 'old-engine', 'utf8');
      await writeFile(join(dirname(installServerBinaryPath), 'node_modules', '@prisma', 'client', 'index.js'), 'module.exports = { old: true };\n', 'utf8');

      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.applyServicePlan).mockImplementationOnce(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        const readOrMissing = async (path: string) => await readFile(path, 'utf8').catch(() => 'missing');
        serviceSnapshots.push({
          binary: await readOrMissing(installServerBinaryPath),
          generated: await readOrMissing(join(dirname(installServerBinaryPath), 'generated', 'dummy.txt')),
          prismaEngine: await readOrMissing(join(dirname(installServerBinaryPath), 'node_modules', '.prisma', 'client', 'query_engine.so')),
        });
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
      });

      expect(serviceActions).toEqual(['stop', 'install']);
      expect(serviceSnapshots).toEqual([{
        binary: '#!/bin/sh\necho old-runtime\n',
        generated: 'old-generated',
        prismaEngine: 'old-engine',
      }]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uninstalls the service definition when health fails on a first-time install', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-health-first-install-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      checkRelayRuntimeHealthMock.mockResolvedValue({
        reachable: false,
        url: 'http://127.0.0.1:4010',
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      })).rejects.toThrow(/did not become healthy/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'uninstall']);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses the long default health timeout for local relay installs', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-health-timeout-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      });

      expect(checkRelayRuntimeHealthMock).toHaveBeenCalledWith(expect.objectContaining({
        timeoutMs: 120_000,
      }));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uninstalls the service definition when an existing definition exists but no previous runtime can be restored', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-health-no-restore-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
      await writeFile(serviceDefinitionPath, '[Service]\n', 'utf8');

      checkRelayRuntimeHealthMock.mockResolvedValue({
        reachable: false,
        url: 'http://127.0.0.1:4010',
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      })).rejects.toThrow(/did not become healthy/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'uninstall']);
    } finally {
      await rm('/tmp/happier-relay-runtime.service', { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uninstalls the service definition when the previous runtime payload is missing the server binary', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-health-broken-payload-'));
    const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
    try {
      await writeFile(serviceDefinitionPath, '[Service]\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(join(defaults.installRoot, 'bin'), { recursive: true });
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), 'PORT=4010\n', 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      checkRelayRuntimeHealthMock.mockResolvedValue({
        reachable: false,
        url: 'http://127.0.0.1:4010',
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      })).rejects.toThrow(/did not become healthy/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'uninstall']);
    } finally {
      await rm(serviceDefinitionPath, { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('restores the previous runtime payload and env when a later service install step fails after stop', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-restore-failure-'));
    const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      const installServerBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const configEnvPath = join(defaults.configDir, 'server.env');
      await mkdir(dirname(installServerBinaryPath), { recursive: true });
      await mkdir(dirname(configEnvPath), { recursive: true });
      await writeFile(installServerBinaryPath, '#!/bin/sh\necho old-runtime\n', 'utf8');
      await writeFile(configEnvPath, 'PORT=4010\nCUSTOM_FLAG=old\n', 'utf8');

      await writeFile(serviceDefinitionPath, '[Service]\n', 'utf8');

      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        if (action === 'install') {
          throw new Error('install failed');
        }
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
      })).rejects.toThrow(/install failed/);

      await expect(readFile(installServerBinaryPath, 'utf8')).resolves.toContain('old-runtime');
      await expect(readFile(configEnvPath, 'utf8')).resolves.toContain('CUSTOM_FLAG=old');
    } finally {
      await rm(serviceDefinitionPath, { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('restores the service definition when rolling back to an existing runtime payload', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-recovery-'));
    const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      const installServerBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const configEnvPath = join(defaults.configDir, 'server.env');
      await mkdir(dirname(installServerBinaryPath), { recursive: true });
      await mkdir(dirname(configEnvPath), { recursive: true });
      await writeFile(installServerBinaryPath, '#!/bin/sh\necho old-runtime\n', 'utf8');
      await writeFile(configEnvPath, 'PORT=4010\nCUSTOM_FLAG=old\n', 'utf8');

      await writeFile(serviceDefinitionPath, '[Service]\n', 'utf8');

      let installAttempts = 0;
      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        if (action === 'install') {
          installAttempts += 1;
          if (installAttempts === 1) {
            throw new Error('install failed');
          }
        }
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
      })).rejects.toThrow(/install failed/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'install']);
      await expect(readFile(installServerBinaryPath, 'utf8')).resolves.toContain('old-runtime');
      await expect(readFile(configEnvPath, 'utf8')).resolves.toContain('CUSTOM_FLAG=old');
    } finally {
      await rm(serviceDefinitionPath, { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not recreate a service definition when the first install fails without any prior runtime to restore', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-no-restore-'));
    const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        if (action === 'install') {
          throw new Error('install failed');
        }
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
      })).rejects.toThrow(/install failed/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'uninstall']);
      await expect(readFile(serviceDefinitionPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses serviceNameOverride when restoring the service definition after an install failure', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-recovery-service-name-'));
    const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      const installServerBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const configEnvPath = join(defaults.configDir, 'server.env');
      await mkdir(dirname(installServerBinaryPath), { recursive: true });
      await mkdir(dirname(configEnvPath), { recursive: true });
      await writeFile(installServerBinaryPath, '#!/bin/sh\necho old-runtime\n', 'utf8');
      await writeFile(configEnvPath, 'PORT=4010\nCUSTOM_FLAG=old\n', 'utf8');

      await writeFile(serviceDefinitionPath, '[Service]\n', 'utf8');

      const specLabels: string[] = [];
      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.buildServiceDefinition).mockImplementation((params) => {
        specLabels.push(String(params.spec.label ?? ''));
        return {
          kind: 'systemd-service',
          path: serviceDefinitionPath,
          contents: '[Service]\n',
          mode: 0o644,
        };
      });

      let installAttempts = 0;
      vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        if (action === 'install') {
          installAttempts += 1;
          if (installAttempts === 1) {
            throw new Error('install failed');
          }
        }
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
        serviceNameOverride: 'happier-server',
      })).rejects.toThrow(/install failed/);

      expect(specLabels).not.toContain(defaults.serviceName);
      expect(specLabels).toContain('happier-server');
    } finally {
      await rm(serviceDefinitionPath, { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not restore a service definition when rollback has no server binary to restore, even if the unit existed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-missing-payload-'));
    const mockedUnitPath = '/tmp/happier-relay-runtime.service';
    try {
      await mkdir(dirname(mockedUnitPath), { recursive: true });
      await writeFile(mockedUnitPath, '[Service]\n', 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        if (action === 'install') {
          throw new Error('install failed');
        }
      });

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installServerBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
      })).rejects.toThrow(/install failed/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'uninstall']);
      await expect(readFile(installServerBinaryPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(mockedUnitPath, { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uninstalls the service definition when the previous payload dir exists but is missing the server binary', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-missing-binary-'));
    const serviceDefinitionPath = '/tmp/happier-relay-runtime.service';
    try {
      await writeFile(serviceDefinitionPath, '[Service]\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(join(defaults.installRoot, 'bin'), { recursive: true });
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), 'PORT=4010\n', 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      const serviceModule = await import('../service/index.js');
      vi.mocked(serviceModule.applyServicePlan).mockImplementation(async (plan) => {
        const action = (plan as { __action?: string }).__action;
        serviceActions.push(String(action ?? 'unknown'));
        if (action === 'install') {
          throw new Error('install failed');
        }
      });

      const installedShimPath = join(defaults.binDir, 'happier-server');
      await rm(installedShimPath, { force: true });
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
        skipHealthCheck: true,
      })).rejects.toThrow(/install failed/);

      expect(serviceActions).toEqual(['stop', 'install', 'stop', 'uninstall']);
      await expect(readFile(installedShimPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(serviceDefinitionPath, { force: true }).catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('restores the previous state file and cleans backup directories when health fails after install', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-restore-state-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      const statePath = join(defaults.installRoot, 'self-host-state.json');
      const installServerBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const configEnvPath = join(defaults.configDir, 'server.env');

      await mkdir(dirname(installServerBinaryPath), { recursive: true });
      await mkdir(dirname(configEnvPath), { recursive: true });
      await writeFile(installServerBinaryPath, '#!/bin/sh\necho old-runtime\n', 'utf8');
      await writeFile(configEnvPath, 'PORT=4010\nCUSTOM_FLAG=old\n', 'utf8');
      await writeFile(statePath, '{"channel":"preview","mode":"user","version":"0.1.2"}\n', 'utf8');

      checkRelayRuntimeHealthMock.mockResolvedValue({
        reachable: false,
        url: 'http://127.0.0.1:4010',
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      })).rejects.toThrow(/did not become healthy/);

      await expect(readFile(statePath, 'utf8')).resolves.toContain('"version":"0.1.2"');
      const backupDirs = await readdir(defaults.installRoot, { withFileTypes: true });
      expect(backupDirs.filter((entry) => entry.isDirectory() && entry.name.startsWith('.relay-runtime-backup-'))).toEqual([]);
      await expect(lstat(installServerBinaryPath)).resolves.toSatisfy((stats) => stats.isFile());
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('restores a migrated legacy install root to the original unsuffixed path when health fails', async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-legacy-root-rollback-'));
      try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });

      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.installRoot, 'legacy-marker.txt'), 'legacy-root\n', 'utf8');

      checkRelayRuntimeHealthMock.mockResolvedValue({
        reachable: false,
        url: 'http://127.0.0.1:3005',
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      })).rejects.toThrow(/did not become healthy/);

      await expect(readFile(join(stableDefaults.installRoot, 'legacy-marker.txt'), 'utf8')).resolves.toBe('legacy-root\n');
      await expect(lstat(previewDefaults.installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('reinstalls the legacy unsuffixed service after a migrated preview install fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-legacy-service-rollback-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho new-runtime\n', 'utf8');

      const { resolveRelayRuntimeDefaults } = await import('./relayRuntime.js');
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });

      await mkdir(join(stableDefaults.installRoot, 'bin'), { recursive: true });
      await writeFile(join(stableDefaults.installRoot, 'bin', 'happier-server'), '#!/bin/sh\necho legacy-runtime\n', 'utf8');

      checkRelayRuntimeHealthMock.mockResolvedValue({
        reachable: false,
        url: 'http://127.0.0.1:3005',
      });

      const { installOrUpdateRelayRuntimeLocal } = await import('./relayRuntimeInstall.js');
      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: true,
      })).rejects.toThrow(/did not become healthy/);

      expect(serviceEvents).toContain('uninstall:happier-server-preview');
      expect(serviceEvents).toContain('install:happier-server');
      expect(serviceEvents[serviceEvents.length - 1]).toBe('install:happier-server');
      } finally {
          await rm(homeDir, { recursive: true, force: true });
      }
  });

  it('stages a local relay payload in a writable temp directory when the source payload parent is read-only', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-read-only-parent-'));
    const readOnlyParent = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-read-only-source-'));
    try {
      const payloadRoot = join(readOnlyParent, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await chmod(readOnlyParent, 0o555);

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:3005',
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await expect(access(join(defaults.installRoot, 'bin', 'happier-server'))).resolves.toBeUndefined();
    } finally {
      await chmod(readOnlyParent, 0o755).catch(() => undefined);
      await rm(readOnlyParent, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
