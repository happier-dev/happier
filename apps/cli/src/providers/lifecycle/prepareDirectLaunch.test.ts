import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  createProviderErrorV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';

import { prepareDirectProviderLaunch } from './prepareDirectLaunch';

const connectionId = ProviderConnectionIdSchema.parse('pc_direct');
const bindingMetadata: SessionProviderBindingMetadataV1 = {
  v: 1,
  connectionId,
  contributionKey: 'acme.gateway/gateway',
  connectionRevision: 1,
  protocol: 'openai-responses',
  materialization: 'engineConfig',
  adapterBindingKey: 'gateway',
  compatibilityFingerprint: 'compatibility:v1:one',
  bindingSecurityFingerprint: 'binding-security:v1:one',
  displaySnapshot: {
    providerName: 'Gateway',
    connectionName: 'Gateway',
    connectionRole: 'default',
    connectionDisplayNameMode: 'automatic',
  },
};

describe('direct Provider launch lifecycle', () => {
  it('returns the managed-daemon discriminant before prerequisites or endpoint materialization', async () => {
    const cleanupOnFailure = vi.fn();
    const resolvePrerequisites = vi.fn(async () => ({ ok: true as const }));
    const materializeManagedEndpoint = vi.fn();
    const attempt = {
      deployment: { kind: 'managedLocal' as const },
      authorization: {
        deployment: { kind: 'managedLocal' as const },
        sessionBindingMetadata: bindingMetadata,
        support: { authIsolation: { suppressConnectedServiceIds: [] } },
      },
      materializeManagedEndpoint,
      cleanupOnFailure,
      takeCleanupOnExit: vi.fn(() => null),
    };

    const result = await prepareDirectProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'model-a' },
      },
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      machineId: 'machine-a',
      agentId: 'codex',
      sessionId: 'session-a',
      previousBinding: null,
      confirmation: null,
      connectedServices: null,
      featureEnabled: true,
    }, {
      resolvePrerequisites,
      createAuthorizationAttempt: async () => ({ ok: true, attempt: attempt as never }),
    });

    expect(result).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_managed_requires_daemon', {
        connectionId,
        machineId: 'machine-a',
      }),
    });
    expect(resolvePrerequisites).not.toHaveBeenCalled();
    expect(materializeManagedEndpoint).not.toHaveBeenCalled();
    expect(cleanupOnFailure).toHaveBeenCalledOnce();
  });

  it('materializes and commit-revalidates the exact qualified binding before returning scoped runtime input', async () => {
    const events: string[] = [];
    const cleanupOnFailure = vi.fn(() => events.push('failure-cleanup'));
    const cleanupOnExit = vi.fn(() => events.push('exit-cleanup'));
    const transferLaunchMaterializationCleanupOwnership = vi.fn();
    const attempt = {
      deployment: { kind: 'external' as const },
      authorization: {
        ticket: { connectionId },
        binding: { selection: { modelId: 'model-a' } },
        support: { authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: ['PROVIDER_KEY'] } },
        sessionBindingMetadata: bindingMetadata,
      },
      materializeAfterHooks: vi.fn(async () => {
        events.push('materialize');
        return {
          ok: true as const,
          materialization: {
            providerEnvironmentOverlay: [
              { name: 'PROVIDER_KEY', value: 'secret-value', source: 'provider' as const },
              { name: 'HAPPIER_SESSION_ATTACH_FILE', value: '/tmp/spoofed-attach', source: 'provider' as const },
            ],
            launchMaterialization: {
              v: 1 as const,
              kind: 'engineConfig' as const,
              engineConfig: { provider: 'gateway' },
            },
            additionalRedactionValues: [],
            cleanup: null,
          },
          redactionLease: {
            redact: (value: string) => value.replaceAll('secret-value', '[REDACTED]'),
            values: () => ['secret-value'],
            add: () => {},
            snapshotRedactor: () => (value: string) => value.replaceAll('secret-value', '[REDACTED]'),
            createStreamingSanitizer: () => ({ push: () => '', flush: () => '' }),
            close: vi.fn(),
          },
        };
      }),
      revalidateBeforeCommit: vi.fn(async () => {
        events.push('commit-check');
        return { ok: true as const };
      }),
      cleanupOnFailure,
      takeCleanupOnExit: vi.fn(() => cleanupOnExit),
      transferLaunchMaterializationCleanupOwnership,
    };

    const result = await prepareDirectProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'model-a' },
      },
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      machineId: 'machine-a',
      agentId: 'codex',
      sessionId: 'session-a',
      previousBinding: null,
      confirmation: null,
      connectedServices: null,
      featureEnabled: true,
    }, {
      resolvePrerequisites: async (context) => {
        events.push(`prerequisite:${context.agentTargetKey}`);
        return { ok: true };
      },
      createAuthorizationAttempt: async (context) => {
        events.push(`authorize:${context.agentTargetKey}`);
        return { ok: true, attempt: attempt as never };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      kind: 'provider',
      agentTargetKey: 'backend:codex',
      environment: { PROVIDER_KEY: 'secret-value' },
      unsetEnvKeys: [],
      bindingMetadata,
      launchMaterialization: { kind: 'engineConfig' },
    });
    expect(result).not.toHaveProperty('environment.HAPPIER_SESSION_ATTACH_FILE');
    expect(events).toEqual([
      'authorize:backend:codex',
      'prerequisite:backend:codex',
      'materialize',
      'commit-check',
    ]);
    if (!result.ok || result.kind !== 'provider') throw new Error('Expected Provider launch');
    result.transferLaunchMaterializationCleanupOwnership();
    result.transferLaunchMaterializationCleanupOwnership();
    expect(transferLaunchMaterializationCleanupOwnership).toHaveBeenCalledOnce();
    await result.cleanupOnExit?.();
    await result.cleanupOnExit?.();
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    expect(cleanupOnFailure).not.toHaveBeenCalled();
  });

  it('revalidates the same authorization ticket at the final runtime commit boundary', async () => {
    const cleanupOnExit = vi.fn(async () => undefined);
    const authorizationChanged = createProviderErrorV1('provider_authorization_changed', {
      connectionId,
      machineId: 'machine-a',
    });
    const revalidateBeforeCommit = vi.fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: false as const, error: authorizationChanged });
    const attempt = {
      deployment: { kind: 'external' as const },
      authorization: {
        ticket: { connectionId },
        binding: { selection: { modelId: 'model-a' } },
        support: { authIsolation: { suppressConnectedServiceIds: [] } },
        sessionBindingMetadata: bindingMetadata,
      },
      materializeAfterHooks: vi.fn(async () => ({
        ok: true as const,
        materialization: {
          providerEnvironmentOverlay: [],
          launchMaterialization: { v: 1 as const, kind: 'engineConfig' as const, engineConfig: {} },
        },
        redactionLease: {
          snapshotRedactor: () => (value: string) => value,
        },
      })),
      revalidateBeforeCommit,
      cleanupOnFailure: vi.fn(),
      takeCleanupOnExit: vi.fn(() => cleanupOnExit),
    };

    const result = await prepareDirectProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'model-a' },
      },
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      machineId: 'machine-a',
      agentId: 'codex',
      sessionId: 'session-a',
      previousBinding: null,
      confirmation: null,
      connectedServices: null,
      featureEnabled: true,
    }, {
      resolvePrerequisites: async () => ({ ok: true }),
      createAuthorizationAttempt: async () => ({ ok: true, attempt: attempt as never }),
    });

    if (!result.ok || result.kind !== 'provider') throw new Error('Expected Provider launch');
    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(1);
    await expect(result.revalidateBeforeCommit()).resolves.toEqual({
      ok: false,
      error: authorizationChanged,
    });
    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(2);
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
    await result.cleanupOnExit?.();
    expect(cleanupOnExit).toHaveBeenCalledTimes(1);
  });

  it('refuses before prerequisites, authorization, materialization, or fallback when the feature is disabled', async () => {
    const resolvePrerequisites = vi.fn(async () => ({ ok: true as const }));
    const createAuthorizationAttempt = vi.fn(async () => ({
      ok: false as const,
      error: createProviderErrorV1('provider_connection_not_found', { connectionId }),
    }));

    const result = await prepareDirectProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'model-a' },
      },
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      machineId: 'machine-a',
      agentId: 'codex',
      sessionId: 'session-a',
      previousBinding: null,
      confirmation: null,
      connectedServices: null,
      featureEnabled: false,
    }, { resolvePrerequisites, createAuthorizationAttempt });

    expect(result).toEqual({
      ok: false,
      error: createProviderErrorV1('provider_feature_disabled', {
        connectionId,
        machineId: 'machine-a',
      }),
    });
    expect(resolvePrerequisites).not.toHaveBeenCalled();
    expect(createAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it('suppresses native auth before returning the Provider launch', async () => {
    const events: string[] = [];
    const attempt = {
      deployment: { kind: 'external' as const },
      authorization: {
        sessionBindingMetadata: bindingMetadata,
        support: {
          authIsolation: {
            suppressConnectedServiceIds: ['openai-codex'],
          },
        },
      },
      materializeAfterHooks: vi.fn(async () => {
        events.push('provider-materialize');
        return {
          ok: true as const,
          materialization: {
            providerEnvironmentOverlay: [
              { name: 'SHARED_KEY', value: 'provider-value' },
              { name: 'PROVIDER_ONLY', value: 'provider-only' },
            ],
            launchMaterialization: { kind: 'engineConfig' as const },
          },
          redactionLease: {
            snapshotRedactor: () => (value: string) => value,
          },
        };
      }),
      revalidateBeforeCommit: vi.fn(async () => ({ ok: true as const })),
      cleanupOnFailure: vi.fn(),
      takeCleanupOnExit: vi.fn(() => vi.fn()),
    };
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'native-auth' },
        github: { source: 'connected' as const, selection: 'profile' as const, profileId: 'github' },
      },
    };

    const result = await prepareDirectProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: connectionId, modelId: 'model-a' },
      },
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      machineId: 'machine-a',
      agentId: 'codex',
      sessionId: 'session-a',
      previousBinding: null,
      confirmation: null,
      connectedServices,
      featureEnabled: true,
    }, {
      resolvePrerequisites: async () => ({ ok: true }),
      createAuthorizationAttempt: async () => ({ ok: true, attempt: attempt as never }),
    });

    expect(events).toEqual(['provider-materialize']);
    expect(result).toMatchObject({
      ok: true,
      kind: 'provider',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          github: {
            source: 'connected',
            selection: 'profile',
            profileId: 'github',
          },
        },
      },
      environment: {
        SHARED_KEY: 'provider-value',
        PROVIDER_ONLY: 'provider-only',
      },
    });
  });

  it('releases caller-owned initial resources when a native selection reaches the shared helper', async () => {
    const release = vi.fn(async () => undefined);

    const result = await prepareDirectProviderLaunch({
      selection: {
        v: 1,
        updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native-model' },
      },
      backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
      machineId: 'machine-a',
      agentId: 'codex',
      sessionId: 'session-a',
      previousBinding: null,
      confirmation: null,
      connectedServices: null,
      featureEnabled: true,
    }, {
      resolvePrerequisites: vi.fn(async () => ({ ok: true as const })),
      createAuthorizationAttempt: vi.fn(async () => ({
        ok: false as const,
        error: createProviderErrorV1('provider_connection_not_found'),
      })),
      initialResources: [{ onFailure: release, onExit: release }],
    });

    expect(result).toEqual({
      ok: true,
      kind: 'native',
      environment: {},
      unsetEnvKeys: [],
      cleanupOnExit: null,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

});
