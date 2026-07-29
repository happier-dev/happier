import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { formatPiSessionDirectoryForCwd } from '../sessionFiles.js';
import { PI_DIRECT_AUTH_ENV_KEYS } from '../launchEnvironment.js';
import {
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  resolvePiRequestAuthExtensionPath,
} from '../auth/services/requestAuth/index.js';
import {
  PI_AGENT_RUNTIME_CONTRIBUTION,
  PI_AUTH_ENV_KEYS_TO_NEUTRALIZE,
} from './runtime.js';

const DAEMON_CONTROL_TOKEN = 'pi-daemon-master-control-token-MUST-NOT-LEAK';
const DAEMON_STATE_FILE_PATH = '/tmp/happier-pi-request-auth-daemon.state.json';
const REQUEST_AUTH_CAPABILITY_PATH = '/tmp/happier-pi-request-auth-capability.json';
const RETIRED_PI_BROKER_ENV_KEYS = PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.filter(
  (key) => key !== PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
);

/**
 * No-leak guard: provider credentials must never enter Pi's materialized home, extension, or env.
 * The generated extension receives only a private request-auth capability path and exact purposes.
 */
async function expectNoProviderRefreshTokenLeak(params: Readonly<{
  agentDir: string;
  authJson: string;
  env: Readonly<Record<string, string>>;
  sentinels: readonly string[];
}>): Promise<void> {
  const extensionSource = await readFile(resolvePiRequestAuthExtensionPath(params.agentDir), 'utf8').catch(() => '');
  for (const sentinel of params.sentinels) {
    expect(params.authJson).not.toContain(sentinel);
    expect(extensionSource).not.toContain(sentinel);
    for (const value of Object.values(params.env)) {
      expect(value).not.toContain(sentinel);
    }
  }
}

const PI_REQUEST_AUTH_PURPOSES = Object.freeze({
  anthropic: {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  },
  'openai-codex': {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  },
});
const PI_REQUEST_AUTH_BINDINGS = Object.freeze({
  anthropic: Object.freeze({
    purpose: PI_REQUEST_AUTH_PURPOSES.anthropic,
    target: Object.freeze({
      kind: 'account' as const,
      account: Object.freeze({
        service: Object.freeze({
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        }),
        accountId: 'claude-oauth',
      }),
    }),
  }),
  'openai-codex': Object.freeze({
    purpose: PI_REQUEST_AUTH_PURPOSES['openai-codex'],
    target: Object.freeze({
      kind: 'account' as const,
      account: Object.freeze({
        service: Object.freeze({
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        }),
        accountId: 'codex-pro',
      }),
    }),
  }),
});

function readConnectedServicesContribution() {
  return (PI_AGENT_RUNTIME_CONTRIBUTION as {
    connectedServices?: {
      serviceIds?: readonly string[];
      readConnectedServiceId?: (selection: unknown) => string | null;
      createAuthMaterializationInput?: (serviceId: string, record: unknown) => Record<string, unknown>;
      materializeAuthEnvironment?: (input: Readonly<Record<string, unknown>>) => Promise<{
        env: Readonly<Record<string, string>>;
      }> | { env: Readonly<Record<string, string>> };
      stateSharingDescriptor?: unknown;
      recoveryCapabilities?: unknown;
      usageLimitRecovery?: unknown;
      runtimeAuthAdapter?: unknown;
      shouldRestartForServiceSwitch?: (serviceId: unknown) => boolean;
      sameAuthGroupRequiresResumeReachability?: boolean;
      connectedSwitchSharedStateRequiredReason?: string;
      nativeSwitchSharedStateRequiredReason?: string;
      verifyResumeReachable?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
      resolveCandidatePersistedSessionFile?: (input: Readonly<{ metadata: unknown }>) => string | null;
    };
  }).connectedServices;
}

describe('PI_AGENT_RUNTIME_CONTRIBUTION connected-service materialization', () => {
  it('pins the exact obsolete/inactive Pi auth environment census', () => {
    expect(PI_AUTH_ENV_KEYS_TO_NEUTRALIZE).toEqual([
      'HAPPIER_PI_BROKER_SELECTIONS',
      'HAPPIER_PI_BROKER_DAEMON_STATE_PATH',
      'HAPPIER_PI_BROKER_STATE_PATH',
      'HAPPIER_PI_BROKER_EXTENSION_VERSION',
      'HAPPIER_PI_CONNECTED_SERVICE_SELECTION_IDENTITY',
      'HAPPIER_PI_BROKER_LOAD_NONCE',
      'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH',
      'HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN',
      'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
    ]);
  });

  it('declares exact request-auth materialization for every request-time purpose', () => {
    expect(PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices.requestAuthUses).toEqual([{
      purpose: 'anthropic-model-request',
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com',
        headerNames: ['authorization'],
      },
    }, {
      purpose: 'openai-codex-model-request',
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://chatgpt.com',
        headerNames: ['authorization', 'chatgpt-account-id'],
      },
    }]);
  });

  it('declares the Pi CLI catalog residuals handled through projection', () => {
    expect(PI_AGENT_RUNTIME_CONTRIBUTION).toMatchObject({
      builtInAcpCatalog: true,
      checklists: {},
      cliSessionCommand: {
        backendIdForSessionRuntime: 'pi',
        agentIdForAccountSettings: 'pi',
      },
    });
  });

  it('declares Pi connected-service ids and request-time auth application capabilities', () => {
    const connectedServices = readConnectedServicesContribution();

    expect(connectedServices?.serviceIds).toEqual([
      'openai-codex',
      'openai',
      'claude-subscription',
      'anthropic',
    ]);
    expect(connectedServices?.readConnectedServiceId?.({ serviceId: 'openai' })).toBe('openai');
    expect(connectedServices?.readConnectedServiceId?.({ serviceId: 'gemini' })).toBeNull();
    expect(connectedServices?.stateSharingDescriptor).toMatchObject({
      providerId: 'pi',
      providerSupportStatus: 'supported',
      authIsolation: {
        mode: 'materialized_home',
        secretEntries: ['auth.json'],
      },
    });
    expect(connectedServices?.recoveryCapabilities).toEqual({
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'request_time_auth',
    });
    expect(connectedServices?.usageLimitRecovery).toMatchObject({
      agentId: 'pi',
      fallbackBackoffEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
      maxAttemptsEnvKey: 'HAPPIER_PI_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
    });
  });

  it('materializes Pi auth.json in the same agent-dir layout as the retired host hook', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-auth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'anthropic',
      profileId: 'default',
      kind: 'token',
      token: {
        token: 'sk-ant-plugin',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('anthropic', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        ...(input ?? {}),
      });

      expect(materialized?.env.PI_CODING_AGENT_DIR).toBe(join(root, 'pi-agent-dir'));
      expect(materialized?.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
      await expect(readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8')).resolves.toBe(
        JSON.stringify({
          anthropic: {
            type: 'api_key',
            key: 'sk-ant-plugin',
          },
        }, null, 2) + '\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retires competing broker/request-auth assets and neutralizes legacy env across an auth switch', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-request-auth-upgrade-'));
    const agentDir = join(root, 'pi-agent-dir');
    const extensionsDir = join(agentDir, 'extensions');
    const legacyBrokerDir = join(root, 'broker');
    const currentRequestAuthDir = join(root, 'request-auth');
    const legacyBrokerCapabilityPath = join(legacyBrokerDir, 'capability.json');
    const currentRequestAuthCapabilityPath = join(
      currentRequestAuthDir,
      'capability.json',
    );
    const legacyEnv = Object.fromEntries(
      PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [key, `legacy-${key}`]),
    );

    try {
      await Promise.all([
        mkdir(extensionsDir, { recursive: true }),
        mkdir(legacyBrokerDir, { recursive: true }),
        mkdir(currentRequestAuthDir, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(extensionsDir, 'happier-pi-broker-1.js'), 'legacy broker\n'),
        writeFile(join(extensionsDir, 'happier-pi-request-auth-1.js'), 'superseded request auth\n'),
        writeFile(join(extensionsDir, 'unrelated-extension.js'), 'unrelated\n'),
        writeFile(legacyBrokerCapabilityPath, 'retired secret\n'),
        writeFile(currentRequestAuthCapabilityPath, 'current strict V2\n'),
      ]);

      const requestAuthMaterialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        processEnv: legacyEnv,
        requestAuth: {
          purposeBindings: [PI_REQUEST_AUTH_BINDINGS.anthropic],
          capabilityPath: currentRequestAuthCapabilityPath,
        },
      });
      const expectedRequestAuthExtensions = [
        'happier-pi-request-auth-2.js',
        'unrelated-extension.js',
      ];

      expect((await readdir(extensionsDir)).sort()).toEqual(expectedRequestAuthExtensions);
      expect(Object.fromEntries(
        RETIRED_PI_BROKER_ENV_KEYS.map((key) => [key, requestAuthMaterialized?.env[key]]),
      )).toEqual(Object.fromEntries(
        RETIRED_PI_BROKER_ENV_KEYS.map((key) => [key, '']),
      ));
      expect(requestAuthMaterialized?.env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV])
        .toBe(currentRequestAuthCapabilityPath);
      await expect(readFile(resolvePiRequestAuthExtensionPath(agentDir), 'utf8'))
        .resolves.toContain('registerProvider');
      await expect(lstat(legacyBrokerDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(currentRequestAuthCapabilityPath, 'utf8'))
        .resolves.toBe('current strict V2\n');

      await mkdir(legacyBrokerDir, { recursive: true });
      await Promise.all([
        writeFile(join(extensionsDir, 'happier-pi-broker-1.js'), 'legacy broker again\n'),
        writeFile(join(extensionsDir, 'happier-pi-request-auth-0.js'), 'older request auth\n'),
        writeFile(legacyBrokerCapabilityPath, 'retired secret again\n'),
      ]);
      const directRecord = buildConnectedServiceCredentialRecord({
        now: 1,
        serviceId: 'anthropic',
        profileId: 'direct',
        kind: 'token',
        token: {
          token: 'sk-ant-direct',
          providerAccountId: null,
          providerEmail: null,
        },
      });
      const directInput = connectedServices?.createAuthMaterializationInput?.(
        'anthropic',
        directRecord,
      );
      const directMaterialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        processEnv: legacyEnv,
        ...(directInput ?? {}),
      });

      expect((await readdir(extensionsDir)).sort()).toEqual([
        'unrelated-extension.js',
      ]);
      await expect(readFile(resolvePiRequestAuthExtensionPath(agentDir), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(agentDir, 'auth.json'), 'utf8')).resolves.toBe(
        JSON.stringify({
          anthropic: {
            type: 'api_key',
            key: 'sk-ant-direct',
          },
        }, null, 2) + '\n',
      );
      expect(Object.fromEntries(
        PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [key, directMaterialized?.env[key]]),
      )).toEqual(Object.fromEntries(
        PI_AUTH_ENV_KEYS_TO_NEUTRALIZE.map((key) => [key, '']),
      ));
      await expect(lstat(legacyBrokerDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(currentRequestAuthCapabilityPath, 'utf8'))
        .resolves.toBe('current strict V2\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes Claude subscription OAuth as request-auth-only provider registration', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-claude-oauth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: 'user:profile user:inference user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: 'claude@example.com',
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        requestAuth: {
          purposeBindings: [PI_REQUEST_AUTH_BINDINGS.anthropic],
          capabilityPath: REQUEST_AUTH_CAPABILITY_PATH,
        },
        ...(input ?? {}),
      });
      const env = materialized?.env ?? {};

      expect(env.PI_CODING_AGENT_DIR).toBe(join(root, 'pi-agent-dir'));
      const authJson = await readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8');
      expect(authJson).toBe('{}\n');
      await expect(readFile(resolvePiRequestAuthExtensionPath(join(root, 'pi-agent-dir')), 'utf8'))
        .resolves.toContain('registerProvider');
      expect(env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBe(REQUEST_AUTH_CAPABILITY_PATH);
      expect(Object.fromEntries(PI_DIRECT_AUTH_ENV_KEYS.map((key) => [key, env[key]]))).toEqual(
        Object.fromEntries(PI_DIRECT_AUTH_ENV_KEYS.map((key) => [key, ''])),
      );
      expect(materialized).not.toHaveProperty('brokerCapability');
      await expectNoProviderRefreshTokenLeak({
        agentDir: join(root, 'pi-agent-dir'),
        authJson,
        env,
        sentinels: ['claude-access-token', 'claude-refresh-token', DAEMON_CONTROL_TOKEN],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes OpenAI Codex subscription OAuth as request-auth-only provider registration', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-codex-oauth-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'codex-pro',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'codex-access-token',
        refreshToken: 'codex-refresh-token',
        idToken: null,
        scope: 'openid profile email',
        tokenType: 'Bearer',
        providerAccountId: 'chatgpt-account',
        providerEmail: 'codex@example.com',
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('openai-codex', record);
      const materialized = await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        requestAuth: {
          purposeBindings: [PI_REQUEST_AUTH_BINDINGS['openai-codex']],
          capabilityPath: REQUEST_AUTH_CAPABILITY_PATH,
        },
        ...(input ?? {}),
      });
      const env = materialized?.env ?? {};

      const authJson = await readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8');
      expect(authJson).toBe('{}\n');
      expect(env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]).toBe(REQUEST_AUTH_CAPABILITY_PATH);
      await expect(readFile(resolvePiRequestAuthExtensionPath(join(root, 'pi-agent-dir')), 'utf8'))
        .resolves.toContain('openai-codex-model-request');
      await expectNoProviderRefreshTokenLeak({
        agentDir: join(root, 'pi-agent-dir'),
        authJson,
        env,
        sentinels: ['codex-access-token', 'codex-refresh-token', DAEMON_CONTROL_TOKEN],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['request-auth projection', {}],
    ['the exact declared purpose', {
      requestAuth: {
        purposeBindings: [{
          purpose: {
            consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
            purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
          },
          target: PI_REQUEST_AUTH_BINDINGS.anthropic.target,
        }],
        capabilityPath: REQUEST_AUTH_CAPABILITY_PATH,
      },
    }],
  ])('fails closed when OAuth materialization is missing %s', async (_missing, extra) => {
    const connectedServices = readConnectedServicesContribution();
    const record = buildConnectedServiceCredentialRecord({
      now: 1_700_000_000_000,
      serviceId: 'claude-subscription',
      profileId: 'claude-oauth',
      kind: 'oauth',
      expiresAt: 1_700_003_600_000,
      oauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        idToken: null,
        scope: 'user:profile user:inference user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'claude-account',
        providerEmail: null,
      },
    });

    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-request-auth-refusal-'));
    try {
      const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
      await expect(connectedServices?.materializeAuthEnvironment?.({
          rootDir: root,
          ...extra,
          ...(input ?? {}),
      })).rejects.toThrow(/request-auth/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Claude subscription setup-token materialized as Pi api_key credentials', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-claude-token-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1,
      serviceId: 'claude-subscription',
      profileId: 'claude-token',
      kind: 'token',
      token: {
        token: 'claude-setup-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    try {
      const input = connectedServices?.createAuthMaterializationInput?.('claude-subscription', record);
      await connectedServices?.materializeAuthEnvironment?.({
        rootDir: root,
        ...(input ?? {}),
      });

      await expect(readFile(join(root, 'pi-agent-dir', 'auth.json'), 'utf8')).resolves.toBe(
        JSON.stringify({
          anthropic: {
            type: 'api_key',
            key: 'claude-setup-token',
          },
        }, null, 2) + '\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PI_AGENT_RUNTIME_CONTRIBUTION native connected-service policy', () => {
  it('exports provider-owned resume reachability without a reflective runtime-control row', async () => {
    const connectedServices = readConnectedServicesContribution();
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-contribution-reachable-'));

    try {
      expect(PI_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('runtimeControl');
      const piAgentDir = join(root, 'pi-agent-dir');
      const finalDir = join(piAgentDir, 'sessions', formatPiSessionDirectoryForCwd('/tmp/project'));
      const sessionFile = join(finalDir, '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(finalDir, { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(connectedServices?.verifyResumeReachable?.({
        targetMaterializedRoot: root,
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: piAgentDir },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        targetStrict: true,
      })).resolves.toEqual({ ok: true, resolvedPath: sessionFile });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports provider-owned persisted session-file metadata resolution', () => {
    const connectedServices = readConnectedServicesContribution();

    expect(connectedServices?.resolveCandidatePersistedSessionFile?.({
      metadata: { piSessionFile: ' /tmp/pi-session.jsonl ' },
    })).toBe('/tmp/pi-session.jsonl');
    expect(connectedServices?.resolveCandidatePersistedSessionFile?.({
      metadata: { piSessionFile: '   ' },
    })).toBeNull();
  });

  it('declares the host-owned generic switch-continuity policy', () => {
    const connectedServices = readConnectedServicesContribution();

    expect(connectedServices).toMatchObject({
      runtimeAuthAdapter: expect.any(Object),
      sameAuthGroupRequiresResumeReachability: true,
      connectedSwitchSharedStateRequiredReason: 'pi_exact_connected_service_selection_required',
      nativeSwitchSharedStateRequiredReason: 'pi_session_state_sharing_required',
    });
    expect(connectedServices?.shouldRestartForServiceSwitch?.('anthropic')).toBe(true);
    expect(connectedServices?.shouldRestartForServiceSwitch?.('gemini')).toBe(false);
  });
});
