import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { consoleLogMock } = vi.hoisted(() => ({
  consoleLogMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-home',
    serverUrl: 'https://doctor-user:doctor-url-password-123456@safe-relay.example.test/api?mode=dev&profile=sk-doctor-config-profile-secret-123456&token=doctor-config-url-token-123456#doctor-config-fragment-secret-123456',
    logsDir: '/tmp/happier-doctor-redaction/logs',
    daemonStateFile: '/tmp/happier-doctor-redaction/daemon-state.json',
  },
}));

vi.mock('@/persistence', () => ({
  readSettings: async () => ({
    schemaVersion: 5,
    activeServerId: 'safe-relay',
    servers: {
      safeRelay: {
        id: 'safe-relay',
        name: 'Safe Relay',
        serverUrl: 'https://safe-relay.example.test/api?mode=dev&profile=sk-doctor-settings-profile-secret-123456&token=doctor-settings-token-123456',
        headers: {
          Authorization: 'Bearer doctor-settings-authorization-123456',
          'x-safe-diagnostic': 'keep-this-header',
        },
        diagnostics: {
          env: {
            NODE_ENV: 'test',
            OPENAI_API_KEY: 'sk-doctor-settings-env-1234567890',
          },
          nested: [{
            refreshToken: 'doctor-refresh-token-123456',
          }],
        },
      },
    },
    localEnvironmentVariables: {
      SECRET_TOKEN: 'doctor-legacy-env-token-123456',
    },
  }),
  readCredentials: async () => null,
  readStoredCredentials: async () => ({
    token: 'token-only',
    encryption: null,
  }),
  readDaemonState: async () => ({
    pid: 4242,
    httpPort: 4949,
    startedAt: 1,
    startedWithCliVersion: '9.9.9',
    controlToken: 'doctor-daemon-control-token-123456',
    lastSpawn: {
      argv: [
        '/usr/bin/node',
        '/repo/dist/index.mjs',
        'codex',
        '--api-key',
        'doctor-daemon-argv-secret-123456',
        '--model',
        'useful-model',
      ],
      env: {
        PATH: '/usr/bin',
        SECRET_TOKEN: 'doctor-daemon-env-secret-123456',
      },
    },
  }),
}));

vi.mock('@/daemon/controlClient', () => ({
  checkIfDaemonRunningAndCleanupStaleState: async () => false,
}));

vi.mock('@/daemon/doctor', () => ({
  findRunawayHappyProcesses: vi.fn(async () => []),
  findAllHappyProcesses: vi.fn(async () => [
    {
      pid: 5252,
      type: 'daemon-spawned-session',
      command: '/usr/bin/node /repo/dist/index.mjs codex --api-key doctor-process-arg-secret-123456 --model useful-model --env SECRET_TOKEN=doctor-process-env-secret-123456',
    },
  ]),
}));

vi.mock('@/ui/doctorSnapshot', () => ({
  buildDoctorSnapshot: vi.fn(async () => ({
    server: {
      activeServerId: 'safe-relay',
      serverUrl: 'https://doctor-snapshot-user:doctor-snapshot-password-123456@safe-relay.example.test/api?mode=dev&profile=sk-doctor-snapshot-profile-secret-123456&token=doctor-snapshot-token-123456#doctor-snapshot-fragment-secret-123456',
    },
    accountId: null,
    settings: {
      activeServerId: 'safe-relay',
      servers: [
        {
          id: 'safe-relay',
          name: 'Safe Relay',
          serverUrl: 'https://doctor-configured-user:doctor-configured-password-123456@configured-relay.example.test/api?mode=dev&profile=sk-doctor-configured-profile-secret-123456&token=doctor-configured-token-123456#doctor-configured-fragment-secret-123456',
        },
      ],
    },
  })),
}));

vi.mock('@/ui/doctorRuntimeDiagnostics', () => ({
  buildDoctorRuntimeDiagnostics: () => ({
    runtime: 'node',
    runtimeVersion: 'v24.0.0',
    nodeCompatibilityVersion: 'v24.0.0',
    isEmbeddedBundle: false,
    projectRoot: '/repo/apps/cli',
    wrapperPath: '/repo/apps/cli/bin/happier.mjs',
    cliEntrypointPath: '/repo/apps/cli/dist/index.mjs',
    wrapperExists: true,
    cliEntrypointExists: true,
  }),
  formatDoctorRuntimeLabel: () => 'Node.js v24.0.0',
  formatDoctorSpawnPathLabel: (path: string | null) => path ?? 'embedded in binary',
}));

vi.mock('@/ui/doctorRuntimeInventory', () => ({
  renderDoctorHappierRuntimeInventory: () => '',
}));

import { runDoctorCommand } from './doctor';

describe('doctor output redaction', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;

  beforeEach(() => {
    process.env.HAPPIER_SERVER_URL = 'https://doctor-env-user:doctor-env-password-123456@safe-relay.example.test/api?mode=dev&profile=sk-doctor-env-profile-secret-123456&token=doctor-env-token-123456#doctor-env-fragment-secret-123456';
    consoleLogMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogMock(...args.map(String));
    });
  });

  afterEach(() => {
    if (originalServerUrl === undefined) {
      delete process.env.HAPPIER_SERVER_URL;
    } else {
      process.env.HAPPIER_SERVER_URL = originalServerUrl;
    }
    vi.restoreAllMocks();
  });

  it('redacts nested settings, daemon state, and process argv secrets while preserving useful diagnostics', async () => {
    await runDoctorCommand('all');

    const output = consoleLogMock.mock.calls
      .map((args) => args.join(' '))
      .join('\n');

    expect(output).toContain('Safe Relay');
    expect(output).toContain('mode=dev');
    expect(output).toContain('keep-this-header');
    expect(output).toContain('NODE_ENV');
    expect(output).toContain('/usr/bin');
    expect(output).toContain('useful-model');
    expect(output).toMatch(/redacted/i);
    expect(output).toContain('Authenticated (credentials found)');

    expect(output).not.toContain('doctor-settings-token-123456');
    expect(output).not.toContain('doctor-settings-authorization-123456');
    expect(output).not.toContain('doctor-user');
    expect(output).not.toContain('doctor-url-password-123456');
    expect(output).not.toContain('doctor-config-url-token-123456');
    expect(output).not.toContain('sk-doctor-config-profile-secret-123456');
    expect(output).not.toContain('doctor-config-fragment-secret-123456');
    expect(output).not.toContain('doctor-env-user');
    expect(output).not.toContain('doctor-env-password-123456');
    expect(output).not.toContain('sk-doctor-env-profile-secret-123456');
    expect(output).not.toContain('doctor-env-token-123456');
    expect(output).not.toContain('doctor-env-fragment-secret-123456');
    expect(output).not.toContain('doctor-snapshot-user');
    expect(output).not.toContain('doctor-snapshot-password-123456');
    expect(output).not.toContain('sk-doctor-snapshot-profile-secret-123456');
    expect(output).not.toContain('doctor-snapshot-token-123456');
    expect(output).not.toContain('doctor-snapshot-fragment-secret-123456');
    expect(output).not.toContain('doctor-configured-user');
    expect(output).not.toContain('doctor-configured-password-123456');
    expect(output).not.toContain('sk-doctor-configured-profile-secret-123456');
    expect(output).not.toContain('doctor-configured-token-123456');
    expect(output).not.toContain('doctor-configured-fragment-secret-123456');
    expect(output).not.toContain('sk-doctor-settings-profile-secret-123456');
    expect(output).not.toContain('sk-doctor-settings-env-1234567890');
    expect(output).not.toContain('doctor-refresh-token-123456');
    expect(output).not.toContain('doctor-legacy-env-token-123456');
    expect(output).not.toContain('doctor-daemon-control-token-123456');
    expect(output).not.toContain('doctor-daemon-argv-secret-123456');
    expect(output).not.toContain('doctor-daemon-env-secret-123456');
    expect(output).not.toContain('doctor-process-arg-secret-123456');
    expect(output).not.toContain('doctor-process-env-secret-123456');
  });
});
