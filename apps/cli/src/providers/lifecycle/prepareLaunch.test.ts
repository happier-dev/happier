import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  createProviderErrorV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';

import type { ProviderSpawnAuthorizationAttempt } from '../spawn/authorize';
import { prepareProviderLaunch } from './prepareLaunch';

const connectionId = ProviderConnectionIdSchema.parse('pc_gateway');
const selection: SessionModelSelectionV1 = {
  v: 1,
  updatedAt: 1,
  ref: {
    agentTargetKey: 'backend:codex',
    providerConnectionId: connectionId,
    modelId: 'vendor/model',
  },
};

function binding(overrides: Partial<SessionProviderBindingMetadataV1> = {}): SessionProviderBindingMetadataV1 {
  return {
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
    ...overrides,
  };
}

function attempt(
  bindingOverrides: Partial<SessionProviderBindingMetadataV1> = {},
): ProviderSpawnAuthorizationAttempt {
  return {
    deployment: { kind: 'external' },
    authorization: {
      deployment: { kind: 'external' },
      ticket: {
        connectionId,
        connectionRevision: 1,
        machineId: 'machine-a',
        connectionSecurityFingerprint: 'connection-security:v1:one',
        bindingSecurityFingerprint: 'binding-security:v1:one',
        grantFingerprint: 'grant:v1:one',
        selectedSecretBindingId: 'secret-a',
        selectedSecretRecordFingerprint: 'secret:v1:one',
      },
      bindingSecurityFingerprint: 'binding-security:v1:one',
      observationAuthorizationFingerprint: 'observation:v1:one',
      binding: {
        v: 1,
        agentTargetKey: 'backend:codex',
        selection: {
          connectionId,
          model: { id: 'vendor/model', name: 'Vendor Model' },
        },
        contributionKey: 'acme.gateway/gateway',
        endpoint: {
          endpointTemplateId: 'responses',
          normalizedUrl: 'https://gateway.example/v1',
          protocol: 'openai-responses',
          publicHeaders: {},
        },
        runtimeCredentialTransport: null,
        compatibilityFingerprint: 'compatibility:v1:one',
      },
      prepared: { v: 1, materialization: 'engineConfig', adapterBindingKey: 'gateway' },
      support: {
        acceptsProtocols: ['openai-responses'],
        required: {},
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: {
          suppressConnectedServiceIds: ['openai-codex'],
          ownedEnvKeys: [],
        },
        materialization: 'engineConfig',
        applyPolicy: 'restart_session',
        supportsFreeformModelIds: true,
      },
      adapterVersion: 1,
      credentialReference: { kind: 'none' },
      sessionBindingMetadata: binding(bindingOverrides),
    },
    isAuthorizationCurrent: () => true,
    revalidateBeforeEffect: vi.fn(async () => ({ ok: true as const })),
    materializeAfterHooks: vi.fn(),
    revalidateBeforeCommit: vi.fn(),
    cleanupOnFailure: vi.fn(),
    takeCleanupOnExit: vi.fn(),
  };
}

function base(overrides: Record<string, unknown> = {}) {
  const providerAttempt = attempt();
  return {
    selection,
    backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
    machineId: 'machine-a',
    agentId: 'codex',
    sessionId: 'session-a',
    previousBinding: null,
    confirmation: null,
    connectedServices: {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
        github: { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      },
    },
    featureEnabled: true,
    resolvePrerequisites: vi.fn(async () => ({ ok: true as const })),
    createAuthorizationAttempt: vi.fn(async () => ({ ok: true as const, attempt: providerAttempt })),
    ...overrides,
  };
}

describe('prepareProviderLaunch', () => {
  it('returns native launches without touching Provider prerequisites or authorization', async () => {
    const input = base({ selection: { ...selection, ref: { ...selection.ref, providerConnectionId: null } } });
    await expect(prepareProviderLaunch(input)).resolves.toEqual({ ok: true, kind: 'native' });
    expect(input.resolvePrerequisites).not.toHaveBeenCalled();
    expect(input.createAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it('refuses an omitted selection for a previously Provider-bound session instead of falling back to native', async () => {
    const input = base({ selection: undefined, previousBinding: binding() });

    await expect(prepareProviderLaunch(input)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'provider_binding_changed',
        connectionId,
        action: 'review_and_restart',
      },
    });
    expect(input.resolvePrerequisites).not.toHaveBeenCalled();
    expect(input.createAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it('uses the canonical qualified Agent target and isolates conflicting connected services', async () => {
    const input = base();
    const result = await prepareProviderLaunch(input);

    expect(result).toMatchObject({
      ok: true,
      kind: 'provider',
      agentTargetKey: 'backend:codex',
      connectedServices: {
        v: 1,
        bindingsByServiceId: { github: expect.anything() },
      },
      suppressedConnectedServiceIds: ['openai-codex'],
    });
    expect(input.resolvePrerequisites).toHaveBeenCalledWith(expect.objectContaining({
      agentTargetKey: 'backend:codex',
      connectionId,
      modelId: 'vendor/model',
    }));
    expect(input.createAuthorizationAttempt).toHaveBeenCalledWith(expect.objectContaining({
      agentTargetKey: 'backend:codex',
      machineId: 'machine-a',
      agentId: 'codex',
      selection,
    }));
  });

  it('normalizes a predecessor built-in selection before Provider authorization', async () => {
    const predecessorSelection: SessionModelSelectionV1 = {
      ...selection,
      ref: {
        ...selection.ref,
        agentTargetKey: 'agent:codex',
      },
    };
    const input = base({ selection: predecessorSelection });

    await expect(prepareProviderLaunch(input)).resolves.toMatchObject({
      ok: true,
      kind: 'provider',
      agentTargetKey: 'backend:codex',
    });
    expect(input.createAuthorizationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTargetKey: 'backend:codex',
        selection: {
          ...predecessorSelection,
          ref: {
            ...predecessorSelection.ref,
            agentTargetKey: 'backend:codex',
          },
        },
      }),
    );
  });

  it('keeps predecessor configured and foreign targets distinct before authorization', async () => {
    for (const agentTargetKey of ['acpBackend:codex', 'agent:claude']) {
      const input = base({
        selection: {
          ...selection,
          ref: { ...selection.ref, agentTargetKey },
        },
      });

      await expect(prepareProviderLaunch(input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_incompatible_with_agent' },
      });
      expect(input.createAuthorizationAttempt).not.toHaveBeenCalled();
    }
  });

  it('authorizes before prerequisites and cleans the attempt when a prerequisite later refuses', async () => {
    const error = createProviderErrorV1('provider_agent_runtime_unsupported', {
      connectionId,
      machineId: 'machine-a',
    });
    const providerAttempt = attempt();
    const input = base({
      resolvePrerequisites: vi.fn(async () => ({ ok: false as const, error })),
      createAuthorizationAttempt: vi.fn(async () => ({ ok: true as const, attempt: providerAttempt })),
    });

    await expect(prepareProviderLaunch(input)).resolves.toEqual({ ok: false, error });
    expect(input.createAuthorizationAttempt).toHaveBeenCalledTimes(1);
    expect(providerAttempt.cleanupOnFailure).toHaveBeenCalledTimes(1);
  });

  it('refuses unsafe or stale authorization before any Agent prerequisite work', async () => {
    const error = createProviderErrorV1('provider_machine_grant_stale', {
      connectionId,
      machineId: 'machine-a',
    });
    const input = base({
      createAuthorizationAttempt: vi.fn(async () => ({ ok: false as const, error })),
    });

    await expect(prepareProviderLaunch(input)).resolves.toEqual({ ok: false, error });
    expect(input.resolvePrerequisites).not.toHaveBeenCalled();
  });

  it('refuses a stale persisted binding with the continuity error returned by the canonical resolver', async () => {
    const input = base({
      previousBinding: binding({ bindingSecurityFingerprint: 'binding-security:v1:old' }),
    });

    await expect(prepareProviderLaunch(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_binding_changed', action: 'review_and_restart' },
    });
  });

  it('reauthorizes the persisted managed purpose snapshot instead of future connection defaults', async () => {
    const persistedPurposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'acme.gateway', localId: 'gateway' },
          purpose: 'inference',
        },
        target: {
          kind: 'group',
          service: { pluginId: 'acme.accounts', localId: 'openai' },
          groupId: 'group-original',
        },
      }],
    };
    const futurePurposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
      v: 1,
      bindings: [{
        purpose: persistedPurposeBindings.bindings[0]!.purpose,
        target: {
          kind: 'group',
          service: { pluginId: 'acme.accounts', localId: 'openai' },
          groupId: 'group-future-default',
        },
      }],
    };
    const input = base({
      previousBinding: binding({
        managedPurposeBindings: persistedPurposeBindings,
      }),
      createAuthorizationAttempt: vi.fn(async (context: unknown) => {
        const authorizationInput = context as Readonly<{
          managedPurposeBindingSnapshot?: QualifiedConnectedAccountPurposeBindingsV1;
        }>;
        return {
          ok: true as const,
          attempt: attempt({
            managedPurposeBindings:
              authorizationInput.managedPurposeBindingSnapshot
              ?? futurePurposeBindings,
          }),
        };
      }),
    });

    const result = await prepareProviderLaunch(input);

    expect(result).toMatchObject({
      ok: true,
      kind: 'provider',
      attempt: {
        authorization: {
          sessionBindingMetadata: {
            managedPurposeBindings: persistedPurposeBindings,
          },
        },
      },
    });
  });

  it('lets a direct entry point explicitly confirm only the exact observed security change', async () => {
    const confirmSecurityChange = vi.fn(async () => true);
    const input = base({
      previousBinding: binding({ bindingSecurityFingerprint: 'binding-security:v1:old' }),
      confirmSecurityChange,
    });

    await expect(prepareProviderLaunch(input)).resolves.toMatchObject({ ok: true, kind: 'provider' });
    expect(confirmSecurityChange).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      sessionId: 'session-a',
      connectionId,
      previousBindingSecurityFingerprint: 'binding-security:v1:old',
      nextBindingSecurityFingerprint: 'binding-security:v1:one',
    }));
  });

  it('fails closed before prerequisites when Provider feature, machine, or Agent identity is absent', async () => {
    const disabled = base({ featureEnabled: false });
    await expect(prepareProviderLaunch(disabled)).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_feature_disabled' },
    });
    expect(disabled.resolvePrerequisites).not.toHaveBeenCalled();

    for (const overrides of [{ machineId: undefined }, { agentId: null }]) {
      const invalid = base(overrides);
      await expect(prepareProviderLaunch(invalid)).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_incompatible_with_agent' },
      });
      expect(invalid.resolvePrerequisites).not.toHaveBeenCalled();
    }
  });

  it('validates connected-service input before creating a Provider authorization attempt', async () => {
    const input = base({
      connectedServices: { v: 1, bindingsByServiceId: { github: { source: 'invalid' } } },
    });

    await expect(prepareProviderLaunch(input as Parameters<typeof prepareProviderLaunch>[0]))
      .resolves.toMatchObject({ ok: false, error: { code: 'provider_settings_invalid' } });
    expect(input.resolvePrerequisites).not.toHaveBeenCalled();
    expect(input.createAuthorizationAttempt).not.toHaveBeenCalled();
  });
});
