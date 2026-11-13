import { logger } from '@/ui/logger';
import { rmSync } from 'node:fs';
import { createManagedRunLaunchFixture } from '../lifecycle/managedRunLaunch.testkit';
import { materializeLeasedAgentProviderBinding } from '@/plugins/runtime/providerBindings/adapter';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type {
  AgentProviderBindingMaterializationV1,
} from '@happier-dev/protocol';
import {
  ProviderConnectionIdSchema,
  accountSettingsParse,
  DEFAULT_PROVIDER_SETTINGS_V1,
  encryptSecretStringV1,
  ProviderContributionV1Schema,
  ProviderSettingsV1Schema,
  ProviderCredentialTransportV1Schema,
  SessionModelSelectionV1Schema,
  setProviderExperimentalConfirmationV1,
  createProviderErrorV1,
} from '@happier-dev/protocol';

import { resolveProviderSpawnAuthorization, resolveProviderSpawnDefinitiveRejection, type ProviderSpawnAuthorization } from './resolve';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveProviderConnectionForMachine } from '../registry';
import { resolveProviderModelCompatibility } from '../catalog/compatibility';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import {
  createProviderSpawnAuthorizationAttempt,
  createRuntimeProviderSpawnAuthorizationAttempt,
  filterSuppressedConnectedServiceBindings,
} from './authorize';
import { createAuthoritativeProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import { createProviderRedactionLease } from './redaction';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readPersistedProviderResumeState } from '../lifecycle/readPersistedResumeSelection';
import { resolveSpawnBindingContinuity } from '../sessions/resolveSpawnBindingContinuity';

// Filesystem removal is the teardown boundary; the registered Agent stays real.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

// Count the admitted flow without replacing either canonical decision.
vi.mock('./resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolve')>();
  return {
    ...actual,
    resolveProviderSpawnDefinitiveRejection: vi.fn(actual.resolveProviderSpawnDefinitiveRejection),
    resolveProviderSpawnAuthorization: vi.fn(actual.resolveProviderSpawnAuthorization),
  };
});

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



describe('provider spawn authorization lifecycle', () => {
  it('does not latch a pre-adoption retained check and ignores desired Q after exact custody binds', () => {
    let desiredCurrent = true;
    let retainedPolicyCurrent = true;
    let exactRetainedRuntimeCurrent = true;
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      resolveCredential: () => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-retained-p',
      isCurrent: () => desiredCurrent && retainedPolicyCurrent,
      isRetainedPolicyCurrent: () => retainedPolicyCurrent,
    });

    expect(attempt.isAuthorizationCurrent()).toBe(true);
    expect(attempt.isRetainedAuthorizationCurrent({})).toBe(false);

    desiredCurrent = false;
    expect(attempt.isAuthorizationCurrent()).toBe(false);
    expect(attempt.isRetainedAuthorizationCurrent({
      isExactRetainedRuntimeCurrent: () => exactRetainedRuntimeCurrent,
    })).toBe(true);

    desiredCurrent = true;
    expect(attempt.isRetainedAuthorizationCurrent({})).toBe(true);

    expect(attempt.isAuthorizationCurrent()).toBe(false);
    expect(exactRetainedRuntimeCurrent).toBe(true);
  });

  it.each([
    {
      label: 'exact runtime release',
      revoke: (state: { exactCurrent: boolean; retainedPolicyCurrent: boolean }) => {
        state.exactCurrent = false;
      },
    },
    {
      label: 'settings, account, grant, trust, or security revocation',
      revoke: (state: { exactCurrent: boolean; retainedPolicyCurrent: boolean }) => {
        state.retainedPolicyCurrent = false;
      },
    },
  ])('never restores retained P after $label', ({ revoke }) => {
    const state = {
      exactCurrent: true,
      retainedPolicyCurrent: true,
    };
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      resolveCredential: () => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-retained-p',
      isCurrent: () => true,
      isRetainedPolicyCurrent: () => state.retainedPolicyCurrent,
    });
    const isExactRetainedRuntimeCurrent = () => state.exactCurrent;

    expect(attempt.isRetainedAuthorizationCurrent({
      isExactRetainedRuntimeCurrent,
    })).toBe(true);

    revoke(state);
    expect(attempt.isRetainedAuthorizationCurrent({})).toBe(false);

    state.exactCurrent = true;
    state.retainedPolicyCurrent = true;
    expect(attempt.isRetainedAuthorizationCurrent({
      isExactRetainedRuntimeCurrent,
    })).toBe(false);
  });

  it('fails closed and permanently when the exact custody callback throws after binding', () => {
    let shouldThrow = false;
    const attempt = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      resolveCredential: () => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-retained-p',
      isCurrent: () => true,
      isRetainedPolicyCurrent: () => true,
    });
    const isExactRetainedRuntimeCurrent = () => {
      if (shouldThrow) throw new Error('custody unavailable');
      return true;
    };

    expect(attempt.isRetainedAuthorizationCurrent({
      isExactRetainedRuntimeCurrent,
    })).toBe(true);
    shouldThrow = true;
    expect(attempt.isRetainedAuthorizationCurrent({})).toBe(false);
    shouldThrow = false;
    expect(attempt.isRetainedAuthorizationCurrent({
      isExactRetainedRuntimeCurrent,
    })).toBe(false);
  });



  it.each(['apiKey', 'none'] as const)('admits and materializes a %s Provider through the real Agent adapter', async (credentialKind) => {
    const pluginId = 'example.spawn-count';
    const contributionKey = `${pluginId}/gateway`;
    const definition = ProviderContributionV1Schema.parse({
      v: 1, id: 'gateway', name: 'Gateway', kind: 'cloud',
      endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://gateway.example/v1',
        capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } }],
      ...(credentialKind === 'apiKey' ? { credential: { kind: 'apiKey', required: true, transports: [transport] } } : {}),
      catalog: { source: 'static', manualModelPolicy: 'allowed', staticModels: [
        { id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' },
      ] },
    });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { providers: [definition] } }),
        files: { 'daemon.mjs': 'export function activate() {}' } }],
      runtimeOptions: { pluginIds: [pluginId, 'happier.agent.codex'] },
    });
    onTestFinished(() => runtime.dispose());
    const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
      v: 1, id: connectionId, source: { kind: 'contribution', contributionKey }, role: 'default',
      displayName: 'Gateway', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1,
    }] });
    const connection = resolveProviderConnectionForMachine({ connectionId, machineId: 'machine-a',
      providerSettings: initial, registry: runtime.registry.contributes,
      dnsEvidenceByEndpointUrl: new Map([['https://gateway.example/v1', ['8.8.8.8']]]) });
    expect(connection).toMatchObject({ status: 'resolved' });
    if (connection.status !== 'resolved') throw new Error('Expected external fixture connection');
    const granted = ProviderSettingsV1Schema.parse({ ...initial,
      accountGrants: [{ v: 1, connectionId, confirmedAt: 1,
        connectionSecurityFingerprint: connection.record.connectionSecurityFingerprint }],
      ...(credentialKind === 'apiKey' ? { secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: 'secret-a' } } } } : {}),
    });
    const adapter = readLeasedAgentProviderBindingAdapter({ lease: runtime.lease, agentId: 'codex' });
    if (!adapter || !('staticModels' in definition.catalog)) throw new Error('Expected real Agent adapter and static Provider model');
    const model = definition.catalog.staticModels[0]!;
    const compatibility = resolveProviderModelCompatibility({ record: connection.record, providerSettings: granted,
      agentTargetKey: 'agent:happier.agent.codex/codex', support: adapter.support,
      adapterVersion: adapter.adapter.adapterVersion, model });
    if (compatibility.result.status !== 'experimental') throw new Error('Expected experimental external Provider pairing');
    let settings = setProviderExperimentalConfirmationV1(granted, { connectionId,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      modelId: compatibility.result.confirmationScope.kind === 'model' ? model.id : null,
      compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmedAt: 1 });
    // Mirror the explicit model confirmations performed before the live restart proposal.
    for (const modelId of ['model-b', 'freeform-model']) {
      const candidate = resolveProviderModelCompatibility({ record: connection.record, providerSettings: settings,
        agentTargetKey: 'agent:happier.agent.codex/codex', support: adapter.support,
        adapterVersion: adapter.adapter.adapterVersion, model: { id: modelId, name: modelId } });
      if (candidate.result.status !== 'experimental') throw new Error('Expected experimental resume model');
      settings = setProviderExperimentalConfirmationV1(settings, { connectionId,
        agentTargetKey: 'agent:happier.agent.codex/codex',
        modelId: candidate.result.confirmationScope.kind === 'model' ? modelId : null,
        compatibilityFingerprint: candidate.compatibilityFingerprint, confirmedAt: 1 });
    }
    const snapshot: ActiveAccountSettingsSnapshot = {
      source: 'network', settings: accountSettingsParse({ secrets: credentialKind === 'apiKey' ? [{ id: 'secret-a', name: 'Fixture key', encryptedValue: {
        _isSecretValue: true, encryptedValue: encryptSecretStringV1('fixture-key', new Uint8Array(32).fill(5),
          length => new Uint8Array(length).fill(2)),
      } }] : [] }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [new Uint8Array(32).fill(5)], scopeKey: 'spawn-count-account',
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
    };
    vi.mocked(resolveProviderSpawnDefinitiveRejection).mockClear();
    vi.mocked(resolveProviderSpawnAuthorization).mockClear();
    const result = await createRuntimeProviderSpawnAuthorizationAttempt({
      selection: SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1, ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a',
      } }), machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex',
      lease: runtime.lease, getAccountSettingsSnapshot: () => snapshot,
      materializationBaseDir: '/unused', sessionId: 'spawn-count', resolveAddresses: async () => ['8.8.8.8'],
    });
    expect(result.ok, result.ok ? undefined : result.error.code).toBe(true);
    if (result.ok) {
      try {
        if (!('materializeAfterHooks' in result.attempt)) throw new Error('Expected external Provider attempt');
        const materialized = await result.attempt.materializeAfterHooks();
        expect(materialized.ok, materialized.ok ? undefined : materialized.error.code).toBe(true);
        if (materialized.ok) expect(materialized.materialization.launchMaterialization.kind).toBe('engineConfig');
      } finally {
        result.attempt.cleanupOnFailure();
      }
    }
    expect(resolveProviderSpawnDefinitiveRejection).toHaveBeenCalledOnce();
    expect(resolveProviderSpawnAuthorization).toHaveBeenCalledOnce();
    if (!result.ok) return;
    const previous = result.attempt.authorization.sessionBindingMetadata;
    for (const modelId of ['model-a', 'model-b', 'freeform-model']) {
      const restored = readPersistedProviderResumeState({ providerBindingV1: previous,
        modelSelectionIntentV1: { v: 1, updatedAt: 2, selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId,
        } },
      });
      if (!restored.selection) throw new Error('Expected persisted Resume intent');
      const resumed = await createRuntimeProviderSpawnAuthorizationAttempt({
        selection: restored.selection, machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', agentId: 'codex',
        lease: runtime.lease, getAccountSettingsSnapshot: () => snapshot,
        materializationBaseDir: '/unused', sessionId: 'spawn-count', resolveAddresses: async () => ['8.8.8.8'],
      });
      expect(resumed.ok, `${credentialKind}/${modelId}: ${resumed.ok ? '' : resumed.error.code}`).toBe(true);
      if (!resumed.ok) continue;
      try {
        const next = resumed.attempt.authorization.sessionBindingMetadata;
        const continuity = resolveSpawnBindingContinuity({ previous: restored.binding, next, sessionId: 'spawn-count', confirmation: null });
        expect.soft(continuity, `${credentialKind}/${modelId}: ${continuity.ok ? continuity.change : continuity.error.code}`)
          .toMatchObject({ ok: true });
        expect(next.model?.id).toBe(modelId);
        if (!('materializeAfterHooks' in resumed.attempt)) throw new Error('Expected external Resume Provider attempt');
        const materialized = await resumed.attempt.materializeAfterHooks();
        expect(materialized.ok, materialized.ok ? undefined : materialized.error.code).toBe(true);
        if (materialized.ok) expect(materialized.materialization.launchMaterialization.kind).toBe('engineConfig');
      } finally {
        resumed.attempt.cleanupOnFailure();
      }
    }
  });

  it('rejects a missing Provider connection before Agent activation', async () => {
    const pluginId = 'happier.agent.codex';
    const getAccountSettingsSnapshot = vi.fn(() => ({
      source: 'network' as const,
      settings: {} as ActiveAccountSettingsSnapshot['settings'],
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
    }) as ActiveAccountSettingsSnapshot);
    const activateContributionsOnDemand = vi.fn(async () => [{
      pluginId,
      diagnostics: [{
        code: 'plugin_activation_failed',
        message: 'fixture activation details must not escape',
      }],
    }]);
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
        durableRevision: -1,
        release: async () => undefined,
        registry: {
          activatedPluginIds: new Set(),
          contributes: {
            agentDefinitionsById: new Map([['codex', {
              pluginId,
              identity: { pluginId, localId: 'codex' },
            }]]),
          },
          activateContributionsOnDemand,
        } as never,
      },
      getAccountSettingsSnapshot,
      materializationBaseDir: '/unused',
      sessionId: 'session-activation-failure',
    });

    expect(result).toMatchObject({ ok: false });
    expect(getAccountSettingsSnapshot).toHaveBeenCalledOnce();
    expect(activateContributionsOnDemand).not.toHaveBeenCalled();
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
        durableRevision: -1,
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
      bindings: { v: 2, bindingsByServiceId: {
        'acme.agent/native-auth': { source: 'connected', selection: 'profile', profileId: 'selected' },
        'other.agent/native-auth': { source: 'connected', selection: 'profile', profileId: 'unrelated' },
      } },
      suppressConnectedServiceIds: ['acme.agent/native-auth'],
    })).toEqual({ bindings: { v: 2, bindingsByServiceId: {
      'other.agent/native-auth': { source: 'connected', selection: 'profile', profileId: 'unrelated' },
    } }, suppressedServiceIds: ['acme.agent/native-auth'] });
    expect(filterSuppressedConnectedServiceBindings({
      bindings: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-work' },
          'acme.external/accounts': { source: 'connected', selection: 'profile', profileId: 'external-work' },
        },
      },
      suppressConnectedServiceIds: ['openai-codex'],
    })).toEqual({
      bindings: {
        v: 2,
        bindingsByServiceId: {
          'acme.external/accounts': { source: 'connected', selection: 'profile', profileId: 'external-work' },
        },
      },
      suppressedServiceIds: ['openai-codex'],
    });
    expect(filterSuppressedConnectedServiceBindings({
      bindings: { v: 2, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-work' },
      } },
      suppressConnectedServiceIds: ['openai-codex'],
    })).toEqual({ bindings: null, suppressedServiceIds: ['openai-codex'] });
    // An empty caller selection was not cleared by Provider authority and
    // must retain its existing distinct Account-defaulting semantics.
    expect(filterSuppressedConnectedServiceBindings({
      bindings: { v: 2, bindingsByServiceId: {} }, suppressConnectedServiceIds: ['openai-codex'],
    })).toEqual({ bindings: { v: 2, bindingsByServiceId: {} }, suppressedServiceIds: [] });
  });

  it('uses its admitted authorization and materializes credentials once', async () => {
    const events: string[] = [];
    const materialization: AgentProviderBindingMaterializationV1 = {
      v: 1, kind: 'engineConfig',
      env: [{ name: 'PROVIDER_KEY', value: 'secret-value', source: 'provider' }],
      engineConfig: { provider: 'gateway' },
    };
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
      resolveCredential,
      materialize,
      materializationBaseDir: '/unused',
      sessionId: 'session-a',
    });

    const late = await attempt.materializeAfterHooks();
    expect(late.ok).toBe(true);
    expect(events).toEqual(['decrypt', 'materialize']);
    expect(await attempt.revalidateBeforeCommit()).toEqual({ ok: true });
    expect(events).toEqual(['decrypt', 'materialize']);
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
      resolveCredential: () => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-redaction',
      createRedactionLease: ({ values }) => {
        observedValues.push([...values]);
        return createProviderRedactionLease({ values });
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

  it('commits no materialization and cleans transient state when its Account custody ends', async () => {
    const materialize = vi.fn(async (): Promise<AgentProviderBindingMaterializationV1> => ({
      v: 1, kind: 'engineConfig', env: [{ name: 'PROVIDER_KEY', value: 'secret-value', source: 'provider' }], engineConfig: {},
    }));
    const firstGap = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      isCurrent: () => false,
      resolveCredential: vi.fn(() => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } })),
      materialize,
      materializationBaseDir: '/unused', sessionId: 'session-a',
    });
    await expect(firstGap.materializeAfterHooks()).resolves.toEqual({ ok: false, error: changedError });
    expect(materialize).not.toHaveBeenCalled();

    let accountCurrent = true;
    const secondGap = createProviderSpawnAuthorizationAttempt({
      initial: authorization(),
      isCurrent: () => accountCurrent,
      resolveCredential: vi.fn(() => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } })),
      materialize,
      materializationBaseDir: '/unused', sessionId: 'session-b',
    });
    await expect(secondGap.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    accountCurrent = false;
    await expect(secondGap.revalidateBeforeCommit()).resolves.toEqual({ ok: false, error: changedError });
    expect(materialize).toHaveBeenCalledTimes(1);
    secondGap.cleanupOnFailure();
    secondGap.cleanupOnFailure();
  });

  it('keeps captured authorization when only the connection revision changes', async () => {
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
      resolveCredential: () => ({ ok: true as const, credential: { kind: 'apiKey' as const, value: 'secret-value' } }),
      materialize: async () => ({ v: 1, kind: 'spawnEnv', env: [] }),
      materializationBaseDir: '/unused',
      sessionId: 'session-settings-revalidation',
      createRedactionLease: ({ values }) => createProviderRedactionLease({ values, onClose: close }),
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    currentSnapshot = makeSnapshot(2, 2);
    await expect(attempt.revalidateBeforeCommit()).resolves.toEqual({ ok: true });
    expect(close).not.toHaveBeenCalled();
    attempt.cleanupOnFailure();
    expect(close).toHaveBeenCalledTimes(1);
    expect(attempt.takeCleanupOnExit()).toBeNull();
  });

  it.each(['disappears', 'switches Account'] as const)(
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
      isCurrent: () => readSnapshot() !== null,
      resolveCredential: () => ({
        ok: true as const,
        credential: { kind: 'apiKey' as const, value: 'secret-value' },
      }),
      materialize: async () => ({ v: 1, kind: 'engineConfig', env: [], engineConfig: {} }),
      materializationBaseDir: '/unused',
      sessionId: 'session-account-scope-change',
      createRedactionLease: ({ values }) => createProviderRedactionLease({ values, onClose: close }),
    });

    await expect(attempt.materializeAfterHooks()).resolves.toMatchObject({ ok: true });
    currentSnapshot = change === 'disappears'
      ? null
      : { ...initialSnapshot, scopeKey: 'account-b' };
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
        failureCause: { errorClass: 'Error', errorCode: null },
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
        failureCause: { errorClass: 'Error', errorCode: null },
        connectionId,
        machineId: 'machine-a',
        retryable: false,
        action: 'review_connection',
      },
    });
    attempt.cleanupOnFailure();
  });
});


it('retains the real Agent materialization failure when redaction teardown also fails', async () => {
  const fixture = await createManagedRunLaunchFixture({ materializationUrl: 'http://127.0.0.1:0' });
  onTestFinished(() => fixture.cleanup());
  const registered = readLeasedAgentProviderBindingAdapter({ lease: fixture.lease, agentId: fixture.agentId });
  if (!registered) throw new Error('Missing admitted fixture Agent adapter');
  const initial: ExternalProviderSpawnAuthorization = { ...authorization(),
    binding: { ...authorization().binding, agentTargetKey: fixture.agentTargetKey },
    prepared: { v: 1, materialization: 'spawnEnv' }, support: registered.support };
  const cleanupError = Object.assign(new Error('private redaction teardown fixture'), { code: 'EBUSY' });
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  onTestFinished(() => diagnostic.mockRestore());
  const attempt = createProviderSpawnAuthorizationAttempt({
    initial,
    resolveCredential: () => ({ ok: true, credential: { kind: 'apiKey', value: 'fixture-private' } }),
    materialize: ({ authorization: admitted, binding, credential }) => materializeLeasedAgentProviderBinding({
      lease: fixture.lease, agentId: fixture.agentId, binding, prepared: admitted.prepared, credential,
    }),
    materializationBaseDir: fixture.happyHomeDir,
    createRedactionLease: ({ values }) => createProviderRedactionLease({ values,
      // The close notification is a caller-owned teardown boundary.
      onClose: () => { throw cleanupError; } }),
  });
  const failure = await attempt.materializeAfterHooks();
  expect(failure).toMatchObject({ ok: false, error: { code: 'provider_materialization_failed',
    failureCause: { errorClass: 'TypeError', errorCode: 'ECONNREFUSED' } } });
  expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
    failureCause: expect.objectContaining({ errorClass: 'Error', errorCode: 'EBUSY' }),
  }));
  expect(JSON.stringify([failure, diagnostic.mock.calls])).not.toContain('fixture-private');
});


it.each(['generation', 'retained'] as const)('retains ordered cleanup failures for a %s Agent materialization', async owner => {
  const fixture = await createManagedRunLaunchFixture({ materializationFiles: [{ relativePath: 'config.json', utf8: '{}' }] });
  onTestFinished(() => fixture.cleanup());
  const registered = readLeasedAgentProviderBindingAdapter({ lease: fixture.lease, agentId: fixture.agentId });
  if (!registered) throw new Error('Missing admitted fixture Agent adapter');
  const initial: ExternalProviderSpawnAuthorization = { ...authorization(),
    binding: { ...authorization().binding, agentTargetKey: fixture.agentTargetKey },
    prepared: { v: 1, materialization: 'configFile' }, support: registered.support };
  const physicalError = Object.assign(new Error('private physical cleanup fixture'), { code: 'EACCES' });
  const redactionError = Object.assign(new Error('private redaction cleanup fixture'), { code: 'EBUSY' });
  const subscriptionError = Object.assign(new Error('private subscription cleanup fixture'), { code: 'EIO' });
  const order: string[] = [];
  const attempt = createProviderSpawnAuthorizationAttempt({
    initial,
    resolveCredential: () => ({ ok: true, credential: { kind: 'apiKey', value: 'fixture-private' } }),
    materialize: ({ authorization: admitted, binding, credential }) => materializeLeasedAgentProviderBinding({
      lease: fixture.lease, agentId: fixture.agentId, binding, prepared: admitted.prepared, credential,
    }),
    materializationBaseDir: fixture.happyHomeDir,
    createRedactionLease: ({ values }) => createProviderRedactionLease({ values,
      onClose: () => { order.push('redaction'); throw redactionError; } }),
    subscribeCurrentness: () => () => { order.push('subscription'); throw subscriptionError; },
  });
  const materialized = await attempt.materializeAfterHooks();
  expect(materialized.ok).toBe(true);
  if (!materialized.ok || materialized.materialization.launchMaterialization.kind !== 'configFile') throw new Error('Expected real file materialization');
  const root = materialized.materialization.launchMaterialization.rootPath;
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (path === root && options?.recursive) { order.push('physical'); throw physicalError; }
    return actualFs.rmSync(path, options);
  });
  try {
    const cleanup = owner === 'retained' ? attempt.takeCleanupOnExit() : attempt.cleanupOnFailure;
    if (!cleanup) throw new Error('Missing cleanup custody');
    let failure: unknown;
    try { cleanup(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toEqual([physicalError, redactionError, subscriptionError]);
    expect(failure.cause).toBe(physicalError);
    expect(order).toEqual(['physical', 'redaction', 'subscription']);
    expect(projectActionFailureCauseV1(failure)).toMatchObject({ errorClass: 'Error', errorCode: 'EACCES' });
    expect(JSON.stringify(projectActionFailureCauseV1(failure))).not.toContain('private');
  } finally { vi.mocked(rmSync).mockImplementation(actualFs.rmSync); }
});


it('preserves AbortError identity and diagnoses failed materialization teardown', async () => {
  const cancelled = new Error('private cancellation fixture');
  cancelled.name = 'AbortError';
  const cleanupError = Object.assign(new Error('private cancelled cleanup fixture'), { code: 'EBUSY' });
  const subscriptionError = Object.assign(new Error('private cancelled subscription fixture'), { code: 'EIO' });
  const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  onTestFinished(() => diagnostic.mockRestore());
  const attempt = createProviderSpawnAuthorizationAttempt({
    initial: authorization(),
    resolveCredential: () => ({ ok: true, credential: { kind: 'apiKey', value: 'fixture-private' } }),
    materialize: async () => {
      // The real fetch boundary rejects with the caller's cancellation reason.
      await fetch('http://127.0.0.1:0', { signal: AbortSignal.abort(cancelled) });
      return { v: 1, kind: 'spawnEnv', env: [] };
    },
    materializationBaseDir: '/unused',
    subscribeCurrentness: () => () => { throw subscriptionError; },
    createRedactionLease: ({ values }) => createProviderRedactionLease({ values,
      onClose: () => { throw cleanupError; } }),
  });
  await expect(attempt.materializeAfterHooks()).rejects.toBe(cancelled);
  expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
    failureCause: expect.objectContaining({ errorClass: 'Error', errorCode: 'EBUSY' }),
  }));
  expect(diagnostic).toHaveBeenCalledWith('[PROVIDER] Unexpected failure', expect.objectContaining({
    failureCause: expect.objectContaining({ errorClass: 'Error', errorCode: 'EIO' }),
  }));
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private cancelled cleanup fixture');
});
