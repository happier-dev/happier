import { describe, expect, it, vi } from 'vitest';

import type {
  AgentProviderBindingMaterializationV1,
} from '@happier-dev/protocol';
import {
  ProviderConnectionIdSchema,
  ProviderCredentialTransportV1Schema,
  SessionModelSelectionV1Schema,
  createProviderErrorV1,
} from '@happier-dev/protocol';

import type { ProviderSpawnAuthorization } from './resolve';
import {
  createProviderSpawnAuthorizationAttempt,
  createRuntimeProviderSpawnAuthorizationAttempt,
  filterSuppressedConnectedServiceBindings,
  sameManagedProviderAuthorizationCurrentnessBasis,
} from './authorize';
import { createAuthoritativeProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type ExternalProviderSpawnAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'external' } }
>;

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
const transport = ProviderCredentialTransportV1Schema.parse({
  id: 'bearer', protocols: ['openai-responses'], uses: ['runtime'],
  destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
});

function authorization(): ExternalProviderSpawnAuthorization {
  return {
    deployment: { kind: 'external' },
    ticket: {
      connectionId, connectionRevision: 1, machineId: 'machine-a',
      connectionSecurityFingerprint: 'connection-security:v1:one',
      bindingSecurityFingerprint: 'binding-security:v1:one',
      grantFingerprint: 'account-grant:v1:one',
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'saved-secret-record:v1:one',
    },
    bindingSecurityFingerprint: 'binding-security:v1:one',
    observationAuthorizationFingerprint: 'observation-authorization:v1:one',
    binding: {
      v: 1,
      agentTargetKey: 'codex',
      selection: { connectionId, model: { id: 'model-a', name: 'Model A' } },
      contributionKey: 'acme.gateway/gateway',
      endpoint: {
        endpointTemplateId: 'responses', normalizedUrl: 'https://gateway.example/v1',
        protocol: 'openai-responses', publicHeaders: {},
      },
      runtimeCredentialTransport: transport,
      compatibilityFingerprint: 'compatibility:v1:one',
    },
    prepared: { v: 1, materialization: 'engineConfig', adapterBindingKey: 'gateway' },
    support: {
      acceptsProtocols: ['openai-responses'], required: {},
      credentialSupport: { supportsNoAuth: false, apiKeyTransports: [] },
      authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: ['PROVIDER_KEY'] },
      materialization: 'engineConfig', applyPolicy: 'restart_session', supportsFreeformModelIds: true,
    },
    adapterVersion: 1,
    credentialReference: {
      kind: 'apiKey', secretId: 'secret-a', secretRecordFingerprint: 'saved-secret-record:v1:one',
    },
    sessionBindingMetadata: {
      v: 1,
      connectionId,
      contributionKey: 'acme.gateway/gateway',
      connectionRevision: 1,
      model: { id: 'model-a', name: 'Model A' },
      protocol: 'openai-responses',
      materialization: 'engineConfig',
      adapterBindingKey: 'gateway',
      compatibilityFingerprint: 'compatibility:v1:one',
      bindingSecurityFingerprint: 'binding-security:v1:one',
      displaySnapshot: {
        providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default',
        connectionDisplayNameMode: 'automatic',
      },
    },
  };
}

const changedError = createProviderErrorV1('provider_authorization_changed', {
  connectionId,
  machineId: 'machine-a',
});

function managedCurrentnessBasis(accountId: string) {
  return {
    ticket: {
      connectionId,
      machineId: 'machine-a',
      connectionSecurityFingerprint: 'connection-security:v1:managed',
      grantFingerprint: 'machine-grant:v1:managed',
    },
    deployment: {
      contribution: {
        provenance: 'first_party' as const,
        source: { kind: 'bundled' as const },
        identity: {
          pluginId: 'happier.provider.gateway',
          localId: 'gateway',
        },
      },
      implementation: {
        implementationIdentity: {
          pluginId: 'happier.provider.gateway',
          localId: 'gateway',
        },
        facet: {
          managedEndpoint: {
            localService: {
              id: 'gateway-managed',
              launch: {
                kind: 'packaged-runtime-binary' as const,
                directorySegments: ['tools', 'unpacked'],
                executableBaseName: 'gateway-managed',
                privateConfigPathFlag: '--config',
              },
              launchMode: {
                kind: 'assignAndInject' as const,
                portPolicy: { kind: 'allocated' as const },
              },
              hostPolicy: { kind: 'loopback' as const },
              name: { strategy: 'fixed' as const, name: 'Gateway' },
              healthCheck: { kind: 'http' as const, path: '/healthz' },
              restart: { kind: 'never' as const },
              cleanup: { staleAfterMs: 60_000 },
            },
            protocols: ['openai-responses' as const],
          },
          connectedAccounts: [{
            purpose: 'upstream',
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            required: true,
          }],
          requestAuthUses: [{
            purpose: 'upstream',
            materialization: {
              kind: 'httpHeaders' as const,
              origin: 'https://api.example.test',
              headerNames: ['authorization'],
            },
          }],
        },
        purposeBindings: {
          v: 1 as const,
          bindings: [{
            purpose: {
              consumer: {
                pluginId: 'happier.provider.gateway',
                localId: 'gateway',
              },
              purpose: 'upstream',
            },
            target: {
              kind: 'account' as const,
              account: {
                service: {
                  pluginId: 'happier.connected-account.example',
                  localId: 'example',
                },
                accountId,
              },
            },
          }],
        },
      },
    },
  } satisfies Parameters<typeof sameManagedProviderAuthorizationCurrentnessBasis>[0];
}

describe('provider spawn authorization lifecycle', () => {
  it('keeps managed lifetime currentness owned by security, grant, and implementation facts', () => {
    const initial = managedCurrentnessBasis('account-a');
    expect(sameManagedProviderAuthorizationCurrentnessBasis(
      initial,
      managedCurrentnessBasis('account-a'),
    )).toBe(true);
    expect(sameManagedProviderAuthorizationCurrentnessBasis(
      initial,
      managedCurrentnessBasis('account-b'),
    )).toBe(true);
    expect(sameManagedProviderAuthorizationCurrentnessBasis(
      initial,
      {
        ...managedCurrentnessBasis('account-a'),
        ticket: {
          ...managedCurrentnessBasis('account-a').ticket,
          grantFingerprint: 'machine-grant:v1:revoked',
        },
      },
    )).toBe(false);
    expect(sameManagedProviderAuthorizationCurrentnessBasis(
      initial,
      {
        ...managedCurrentnessBasis('account-a'),
        ticket: {
          ...managedCurrentnessBasis('account-a').ticket,
          connectionSecurityFingerprint: 'connection-security:v1:changed',
        },
      },
    )).toBe(false);
  });

  it('preserves Agent activation failure as the typed runtime-unsupported refusal', async () => {
    const pluginId = 'happier.agent.codex';
    const getAccountSettingsSnapshot = vi.fn(() => null);
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex:built_in',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      }),
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex:built_in',
      agentId: 'codex',
      lease: {
        source: 'active',
        release: async () => undefined,
        registry: {
          activatedPluginIds: new Set(),
          contributes: {
            agentDefinitionsById: new Map([['codex', {
              pluginId,
              identity: { pluginId, localId: 'codex' },
            }]]),
          },
          activateContributionsOnDemand: async () => [{
            pluginId,
            diagnostics: [{
              code: 'plugin_activation_failed',
              message: 'fixture activation details must not escape',
            }],
          }],
        } as never,
      },
      getAccountSettingsSnapshot,
      materializationBaseDir: '/unused',
      sessionId: 'session-activation-failure',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'provider_agent_runtime_unsupported',
        connectionId,
        machineId: 'machine-a',
        retryable: false,
        action: 'review_connection',
      },
    });
    expect(getAccountSettingsSnapshot).not.toHaveBeenCalled();
  });

  it('does not relabel diagnostics from an active Agent plugin as activation failure', async () => {
    const pluginId = 'happier.agent.codex';
    const getAccountSettingsSnapshot = vi.fn(() => null);
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex:built_in',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      }),
      machineId: 'machine-a',
      agentTargetKey: 'backend:codex:built_in',
      agentId: 'codex',
      lease: {
        source: 'active',
        release: async () => undefined,
        registry: {
          activatedPluginIds: new Set([pluginId]),
          contributes: {
            agentDefinitionsById: new Map([['codex', {
              pluginId,
              identity: { pluginId, localId: 'codex' },
            }]]),
          },
          activateContributionsOnDemand: async () => [{
            pluginId,
            diagnostics: [{
              code: 'plugin_activation_advisory',
              message: 'fixture advisory',
            }],
          }],
        } as never,
      },
      getAccountSettingsSnapshot,
      materializationBaseDir: '/unused',
      sessionId: 'session-active-advisory',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'provider_connection_not_found' },
    });
    expect(getAccountSettingsSnapshot).toHaveBeenCalledOnce();
  });

  it('filters only selected-intake native auth services and leaves unrelated services intact', () => {
    expect(filterSuppressedConnectedServiceBindings({
      bindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-work' },
          github: { source: 'connected', selection: 'profile', profileId: 'github-work' },
        },
      },
      suppressConnectedServiceIds: ['openai-codex'],
    })).toEqual({
      bindings: {
        v: 1,
        bindingsByServiceId: { github: { source: 'connected', selection: 'profile', profileId: 'github-work' } },
      },
      suppressedServiceIds: ['openai-codex'],
    });
  });

  it('revalidates before decrypt/materialize and again before commit without rerunning side effects', async () => {
    const events: string[] = [];
    const materialization: AgentProviderBindingMaterializationV1 = {
      v: 1, kind: 'engineConfig',
      env: [{ name: 'PROVIDER_KEY', value: 'secret-value', source: 'provider' }],
      engineConfig: { provider: 'gateway' },
    };
    const revalidate = vi.fn(async () => {
      events.push('revalidate');
      return { ok: true as const, authorization: authorization() };
    });
    const resolveCredential = vi.fn(() => {
      events.push('decrypt');
      return { ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } };
    });
    const materialize = vi.fn(async () => {
      events.push('materialize');
      return materialization;
    });
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate,
      resolveCredential,
      materialize,
      materializationBaseDir: '/unused',
      sessionId: 'session-a',
    });

    const late = await attempt.materializeAfterHooks();
    expect(late.ok).toBe(true);
    expect(events).toEqual(['revalidate', 'decrypt', 'materialize']);
    expect(await attempt.revalidateBeforeCommit()).toEqual({ ok: true });
    expect(events).toEqual(['revalidate', 'decrypt', 'materialize', 'revalidate']);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    attempt.cleanupOnFailure();
  });

  it('registers raw/rendered credentials and every Provider public-header value before materialization', async () => {
    const base = authorization();
    const initial: ExternalProviderSpawnAuthorization = {
      ...base,
      binding: {
        ...base.binding,
        endpoint: {
          ...base.binding.endpoint,
          publicHeaders: {
            'x-tenant': 'tenant-sensitive-value',
            'x-routing': 'routing-sensitive-value',
          },
        },
      },
    };
    const observedValues: string[][] = [];
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial,
      revalidate: async () => ({ ok: true as const, authorization: initial }),
      resolveCredential: () => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-redaction',
      createRedactionLease: ({ values }) => {
        observedValues.push([...values]);
        return {
          redact: (value) => value,
          values: () => values,
          add: () => {},
          snapshotRedactor: () => (value) => value,
          createStreamingSanitizer: () => ({ push: (value) => String(value), flush: () => '' }),
          close: () => {},
        };
      },
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    expect(observedValues).toEqual([expect.arrayContaining([
      'secret-value',
      'Bearer secret-value',
      'tenant-sensitive-value',
      'routing-sensitive-value',
    ])]);
    attempt.cleanupOnFailure();
  });

  it('accepts an empty public header without weakening the redaction lease empty-secret invariant', async () => {
    const base = authorization();
    const initial: ExternalProviderSpawnAuthorization = {
      ...base,
      binding: {
        ...base.binding,
        endpoint: {
          ...base.binding.endpoint,
          publicHeaders: { 'x-optional-routing': '' },
        },
      },
    };
    const materialize = vi.fn(async (): Promise<AgentProviderBindingMaterializationV1> => ({
      v: 1,
      kind: 'spawnEnv',
      env: [],
    }));
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial,
      revalidate: async () => ({ ok: true as const, authorization: initial }),
      resolveCredential: () => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      }),
      materialize,
      materializationBaseDir: '/unused',
      sessionId: 'session-empty-public-header',
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    expect(materialize).toHaveBeenCalledTimes(1);
    attempt.cleanupOnFailure();
  });

  it('commits no materialization and cleans transient state when authorization changes in either gap', async () => {
    const materialize = vi.fn(async (): Promise<AgentProviderBindingMaterializationV1> => ({
      v: 1, kind: 'engineConfig', env: [{ name: 'PROVIDER_KEY', value: 'secret-value', source: 'provider' }], engineConfig: {},
    }));
    const firstGap = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: vi.fn(async () => ({ ok: false as const, error: changedError })),
      resolveCredential: vi.fn(() => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } })),
      materialize,
      materializationBaseDir: '/unused', sessionId: 'session-a',
    });
    await expect(firstGap.materializeAfterHooks()).resolves.toEqual({ ok: false, error: changedError });
    expect(materialize).not.toHaveBeenCalled();

    let checks = 0;
    const secondGap = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: vi.fn(async () => (++checks === 1
        ? { ok: true as const, authorization: authorization() }
        : { ok: false as const, error: changedError })),
      resolveCredential: vi.fn(() => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } })),
      materialize,
      materializationBaseDir: '/unused', sessionId: 'session-b',
    });
    await expect(secondGap.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    await expect(secondGap.revalidateBeforeCommit()).resolves.toEqual({ ok: false, error: changedError });
    expect(materialize).toHaveBeenCalledTimes(1);
    secondGap.cleanupOnFailure();
    secondGap.cleanupOnFailure();
  });

  it('re-reads authoritative settings and cleans materialized state when only the connection revision changes', async () => {
    const makeSnapshot = (settingsVersion: number, connectionRevision: number): ActiveAccountSettingsSnapshot => ({
      source: 'network',
      settings: { connectionRevision } as never,
      settingsVersion,
      loadedAtMs: settingsVersion,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-a',
    });
    const initialSnapshot = makeSnapshot(1, 1);
    let currentSnapshot: ActiveAccountSettingsSnapshot | null = initialSnapshot;
    const readSnapshot = createAuthoritativeProviderSnapshotReader({
      initial: initialSnapshot,
      mode: 'live',
      readCurrent: () => currentSnapshot,
    });
    const resolveAuthorization = (): ExternalProviderSpawnAuthorization => {
      const base = authorization();
      const snapshot = readSnapshot();
      if (!snapshot) throw new Error('authoritative settings unavailable');
      const connectionRevision = (snapshot.settings as unknown as { connectionRevision: number }).connectionRevision;
      return { ...base, ticket: { ...base.ticket, connectionRevision } };
    };
    const close = vi.fn();
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: resolveAuthorization(),
      revalidate: async () => ({ ok: true as const, authorization: resolveAuthorization() }),
      resolveCredential: () => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-settings-revalidation',
      createRedactionLease: () => ({
        redact: (value) => value,
        values: () => ['secret-value'],
        add: () => {},
        snapshotRedactor: () => (value) => value,
        createStreamingSanitizer: () => ({ push: () => '', flush: () => '' }),
        close,
      }),
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    currentSnapshot = makeSnapshot(2, 2);
    await expect(attempt.revalidateBeforeCommit()).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_authorization_changed' },
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(attempt.takeCleanupOnExit()).toBeNull();
  });

  it.each(['disappears', 'regresses'] as const)(
    'fails closed and releases materialized secrets when the live account snapshot %s before commit', async (change) => {
    const initialSnapshot: ActiveAccountSettingsSnapshot = {
      source: 'network',
      settings: {} as never,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: 'account-a',
    };
    let currentSnapshot: ActiveAccountSettingsSnapshot | null = initialSnapshot;
    const readSnapshot = createAuthoritativeProviderSnapshotReader({
      initial: initialSnapshot,
      mode: 'live',
      readCurrent: () => currentSnapshot,
    });
    const close = vi.fn();
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: async () => readSnapshot()
        ? { ok: true as const, authorization: authorization() }
        : { ok: false as const, error: changedError },
      resolveCredential: () => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      }),
      materialize: async () => ({ v: 1, kind: 'engineConfig', env: [], engineConfig: {} }),
      materializationBaseDir: '/unused',
      sessionId: 'session-account-scope-change',
      createRedactionLease: () => ({
        redact: (value) => value,
        values: () => ['secret-value'],
        add: () => {},
        snapshotRedactor: () => (value) => value,
        createStreamingSanitizer: () => ({ push: () => '', flush: () => '' }),
        close,
      }),
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    currentSnapshot = change === 'disappears'
      ? null
      : { ...initialSnapshot, settingsVersion: 0, loadedAtMs: 0 };
    await expect(attempt.revalidateBeforeCommit()).resolves.toEqual({ ok: false, error: changedError });
    expect(close).toHaveBeenCalledTimes(1);
    expect(attempt.takeCleanupOnExit()).toBeNull();
  });

  it('maps a late secret-store/decryption exception to a stable provider refusal', async () => {
    const materialize = vi.fn(async (): Promise<AgentProviderBindingMaterializationV1> => ({
      v: 1,
      kind: 'engineConfig',
      env: [],
      engineConfig: {},
    }));
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: vi.fn(async () => ({ ok: true as const, authorization: authorization() })),
      resolveCredential: vi.fn(() => {
        throw new Error('encrypted envelope parser detail must not escape');
      }),
      materialize,
      materializationBaseDir: '/unused',
      sessionId: 'session-secret-error',
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'provider_secret_missing',
        connectionId: 'pc_gateway',
        machineId: 'machine-a',
      },
    });
    expect(materialize).not.toHaveBeenCalled();
    attempt.cleanupOnFailure();
  });

  it('preserves a typed adapter/materialization provider refusal instead of relabeling it as continuity drift', async () => {
    const adapterError = createProviderErrorV1('provider_credential_transport_unavailable', {
      connectionId,
      machineId: 'machine-a',
    });
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: vi.fn(async () => ({ ok: true as const, authorization: authorization() })),
      resolveCredential: vi.fn(() => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      })),
      materialize: vi.fn(async () => { throw adapterError; }),
      materializationBaseDir: '/unused',
      sessionId: 'session-adapter-error',
    });

    await expect(attempt.materializeAfterHooks()).resolves.toEqual({ ok: false, error: adapterError });
    attempt.cleanupOnFailure();
  });

  it('labels an untyped materialization exception as a stable materialization failure', async () => {
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      revalidate: vi.fn(async () => ({ ok: true as const, authorization: authorization() })),
      resolveCredential: vi.fn(() => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      })),
      materialize: vi.fn(async () => {
        throw new Error('adapter internals and secret-value must not escape');
      }),
      materializationBaseDir: '/unused',
      sessionId: 'session-materialization-error',
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'provider_materialization_failed',
        connectionId,
        machineId: 'machine-a',
        retryable: false,
        action: 'review_connection',
      },
    });
    attempt.cleanupOnFailure();
  });
});
