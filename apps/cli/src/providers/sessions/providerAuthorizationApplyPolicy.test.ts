import { describe, expect, it } from 'vitest';
import {
  createProviderBindingSecurityFingerprintV1,
  ProviderConnectionIdSchema,
  type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import type { ProviderSpawnAuthorization } from '../spawn/resolve';
import { projectProviderRuntimeBindingBasis } from '../spawn/runtimeBindingBasis';

import {
  resolveProviderAuthorizationApplyPolicyForActiveBinding,
  sameProviderAuthorizationRuntimeBindingDimensions,
  sameProviderRuntimeBindingBasis,
} from './providerAuthorizationApplyPolicy';

type ExternalAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'external' } }
>;
type ManagedAuthorization = Extract<
  ProviderSpawnAuthorization,
  { deployment: { kind: 'managedLocal' } }
>;

function resolveApplyPolicyForObservedAuthorization(input: Readonly<{
  current: ProviderSpawnAuthorization;
  next: ProviderSpawnAuthorization;
}>) {
  const active = withRuntimeBindingBasis(input.current);
  return resolveProviderAuthorizationApplyPolicyForActiveBinding({
    activeSelection: {
      agentTargetKey: active.binding.agentTargetKey,
      providerConnectionId: ProviderConnectionIdSchema.parse(
        active.binding.selection.connectionId,
      ),
      modelId: active.binding.selection.model.id,
    },
    activeSessionBindingMetadata: active.sessionBindingMetadata,
    next: input.next,
  });
}

function authorization(modelId: string): ExternalAuthorization {
  const connectionId = ProviderConnectionIdSchema.parse('pc_work');
  return {
    deployment: { kind: 'external' },
    ticket: {
      connectionId,
      connectionRevision: 1,
      machineId: 'machine-a',
      connectionSecurityFingerprint: 'connection-security',
      bindingSecurityFingerprint: `binding-security:${modelId}`,
      grantFingerprint: 'grant',
      selectedSecretBindingId: 'secret-a',
      selectedSecretRecordFingerprint: 'secret-record-a',
    },
    bindingSecurityFingerprint: `binding-security:${modelId}`,
    observationAuthorizationFingerprint: 'observation-authorization:v1:test',
    binding: {
      v: 1,
      agentTargetKey: 'backend:claude',
      selection: {
        connectionId,
        model: { id: modelId, name: modelId },
      },
      contributionKey: 'provider.test',
      endpoint: {
        endpointTemplateId: 'messages',
        normalizedUrl: 'https://provider.example/v1',
        protocol: 'anthropic',
        publicHeaders: { 'x-provider': 'test' },
      },
      runtimeCredentialTransport: {
        id: 'bearer',
        protocols: ['anthropic'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'Authorization',
          format: 'bearer',
        },
      },
      compatibilityFingerprint: `compatibility:${modelId}`,
    },
    prepared: {
      v: 1,
      materialization: 'spawnEnv',
      adapterBindingKey: 'claude-provider',
    },
    support: {
      acceptsProtocols: ['anthropic'],
      required: { streaming: true },
      credentialSupport: {
        supportsNoAuth: false,
        apiKeyTransports: [{
          protocol: 'anthropic',
          destination: {
            kind: 'httpHeader',
            names: ['authorization'],
            formats: ['bearer'],
          },
        }],
      },
      authIsolation: {
        suppressConnectedServiceIds: ['anthropic'],
        ownedEnvKeys: ['ANTHROPIC_API_KEY'],
      },
      materialization: 'spawnEnv',
      applyPolicy: 'live',
      supportsFreeformModelIds: true,
    },
    adapterVersion: 1,
    credentialReference: {
      kind: 'apiKey',
      secretId: 'secret-a',
      secretRecordFingerprint: 'secret-record-a',
    },
    sessionBindingMetadata: {
      v: 1,
      connectionId,
      contributionKey: 'provider.test',
      connectionRevision: 1,
      model: { id: modelId, name: modelId },
      protocol: 'anthropic',
      materialization: 'spawnEnv',
      adapterBindingKey: 'claude-provider',
      compatibilityFingerprint: `compatibility:${modelId}`,
      bindingSecurityFingerprint: `binding-security:${modelId}`,
      displaySnapshot: {
        providerName: 'Provider',
        connectionName: 'Connection',
        connectionRole: 'default',
        connectionDisplayNameMode: 'automatic',
      },
    },
  };
}

function managedAuthorization(
  modelId: string,
  accountId: string,
  purposes: readonly string[] = ['upstream'],
): ManagedAuthorization {
  const base = authorization(modelId);
  const purposeBindings = {
    v: 1 as const,
    bindings: purposes.map((purpose) => ({
      purpose: {
        consumer: { pluginId: 'provider.test', localId: 'gateway' },
        purpose,
      },
      target: {
        kind: 'account' as const,
        account: {
          service: { pluginId: 'connected.test', localId: 'account' },
          accountId,
        },
      },
    })),
  };
      return {
        ...base,
        binding: {
          ...base.binding,
          endpoint: {
            endpointTemplateId: base.binding.endpoint.endpointTemplateId,
            protocol: base.binding.endpoint.protocol,
            publicHeaders: base.binding.endpoint.publicHeaders,
          },
        },
        deployment: {
          kind: 'managedLocal',
          contribution: {} as never,
          implementation: {
            kind: 'managedLocal',
            implementationIdentity: {
              pluginId: 'provider.test',
              localId: 'gateway',
            },
            managedRuntime: {
              kind: 'managed',
              dependencies: [],
              endpointTemplateIds: ['messages'],
              connectedAccounts: purposes.map((purpose) => ({
                purpose,
                service: {
                  pluginId: 'connected.test',
                  localId: 'account',
                },
                required: true,
                materializationKinds: ['httpHeaders'],
              })),
              requestAuthUses: purposes.map((purpose) => ({
                purpose,
                materialization: {
                  kind: 'httpHeaders' as const,
                  origin: 'https://api.example.test',
                  headerNames: ['authorization'],
                },
              })),
            },
            facet: null,
            runtime: {} as never,
            purposeBindings,
          } as never,
    },
    credentialReference: { kind: 'none' },
    sessionBindingMetadata: {
      ...base.sessionBindingMetadata,
      managedPurposeBindings: purposeBindings,
    },
  } as unknown as ManagedAuthorization;
}

function withReversedManagedPurposeBindings(
  input: ManagedAuthorization,
): ManagedAuthorization {
  const purposeBindings = {
    ...input.deployment.implementation.purposeBindings,
    bindings: [
      ...input.deployment.implementation.purposeBindings.bindings,
    ].reverse(),
  };
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        purposeBindings,
      },
    },
    sessionBindingMetadata: {
      ...input.sessionBindingMetadata,
      managedPurposeBindings: purposeBindings,
    },
  };
}

function withReversedManagedConnectedAccounts(
  input: ManagedAuthorization,
): ManagedAuthorization {
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          connectedAccounts: [
            ...input.deployment.implementation.managedRuntime.connectedAccounts,
          ].reverse(),
        },
      },
    },
  };
}

function withChangedManagedConnectedAccountService(
  input: ManagedAuthorization,
): ManagedAuthorization {
  const [first, ...rest] =
    input.deployment.implementation.managedRuntime.connectedAccounts;
  if (!first) throw new TypeError('Expected a managed connected-account declaration');
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          connectedAccounts: [{
            ...first,
            service: {
              ...first.service,
              localId: 'changed-account-service',
            },
          }, ...rest],
        },
      },
    },
  };
}

function withChangedManagedConnectedAccountMaterializationKinds(
  input: ManagedAuthorization,
): ManagedAuthorization {
  const [first, ...rest] =
    input.deployment.implementation.managedRuntime.connectedAccounts;
  if (!first) throw new TypeError('Expected a managed connected-account declaration');
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          connectedAccounts: [{
            ...first,
            materializationKinds: ['httpHeaders', 'environment'],
          }, ...rest],
        },
      },
    },
  };
}

function withChangedManagedConnectedAccountTitle(
  input: ManagedAuthorization,
): ManagedAuthorization {
  const [first, ...rest] =
    input.deployment.implementation.managedRuntime.connectedAccounts;
  if (!first) throw new TypeError('Expected a managed connected-account declaration');
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          connectedAccounts: [{
            ...first,
            title: 'Use the renamed upstream account',
          }, ...rest],
        },
      },
    },
  };
}

function withReversedManagedRequestAuthUses(
  input: ManagedAuthorization,
): ManagedAuthorization {
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          requestAuthUses: [
            ...input.deployment.implementation.managedRuntime.requestAuthUses,
          ].reverse(),
        },
      },
    },
  };
}

function withManagedRequestAuthHeaderNames(
  input: ManagedAuthorization,
  headerNames: readonly string[],
): ManagedAuthorization {
  const [first, ...rest] =
    input.deployment.implementation.managedRuntime.requestAuthUses;
  if (!first) throw new TypeError('Expected a managed request-auth use');
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          requestAuthUses: [{
            ...first,
            materialization: {
              ...first.materialization,
              headerNames: [...headerNames],
            },
          }, ...rest],
        },
      },
    },
  };
}

function withChangedManagedRequestAuthOrigin(
  input: ManagedAuthorization,
): ManagedAuthorization {
  const [first, ...rest] =
    input.deployment.implementation.managedRuntime.requestAuthUses;
  if (!first) throw new TypeError('Expected a managed request-auth use');
  return {
    ...input,
    deployment: {
      ...input.deployment,
      implementation: {
        ...input.deployment.implementation,
        managedRuntime: {
          ...input.deployment.implementation.managedRuntime,
          requestAuthUses: [{
            ...first,
            materialization: {
              ...first.materialization,
              origin: 'https://changed.example.test',
            },
          }, ...rest],
        },
      },
    },
  };
}

function withRuntimeBindingBasis(input: ExternalAuthorization): ExternalAuthorization;
function withRuntimeBindingBasis(input: ManagedAuthorization): ManagedAuthorization;
function withRuntimeBindingBasis(input: ProviderSpawnAuthorization): ProviderSpawnAuthorization;
function withRuntimeBindingBasis(
  input: ProviderSpawnAuthorization,
): ProviderSpawnAuthorization {
  const runtimeBindingBasis = projectProviderRuntimeBindingBasis(input);
  const model = input.sessionBindingMetadata.model;
  if (!model) throw new TypeError('Expected launch model metadata');
  const sharedFingerprintInput = {
    agentTargetKey: runtimeBindingBasis.agentTargetKey,
    connectionId: runtimeBindingBasis.connectionId,
    modelId: model.id,
    modelCapabilities: {
      ...(model.capabilities?.reasoningControls
        ? { reasoningControls: model.capabilities.reasoningControls }
        : {}),
    },
    endpointTemplateId: runtimeBindingBasis.endpoint.endpointTemplateId,
    protocol: runtimeBindingBasis.endpoint.protocol,
    publicHeaders: runtimeBindingBasis.endpoint.publicHeaders,
    materialization: runtimeBindingBasis.prepared.materialization,
    ...(runtimeBindingBasis.prepared.adapterBindingKey
      ? { adapterBindingKey: runtimeBindingBasis.prepared.adapterBindingKey }
      : {}),
    ...(runtimeBindingBasis.runtimeCredentialTransport
      ? {
          credentialDestination:
            runtimeBindingBasis.runtimeCredentialTransport.destination,
        }
      : {}),
    compatibilityFingerprint:
      input.sessionBindingMetadata.compatibilityFingerprint,
    adapterVersion: runtimeBindingBasis.adapterVersion,
  };
  const bindingSecurityFingerprint =
    createLaunchBindingSecurityFingerprint(
      runtimeBindingBasis,
      sharedFingerprintInput,
    );
  return {
    ...input,
    sessionBindingMetadata: {
      ...input.sessionBindingMetadata,
      bindingSecurityFingerprint,
      runtimeBindingBasis,
    },
  };
}

function createLaunchBindingSecurityFingerprint(
  runtimeBindingBasis: ProviderRuntimeBindingBasisV1,
  sharedFingerprintInput: Omit<
    Parameters<typeof createProviderBindingSecurityFingerprintV1>[0],
    'deployment' | 'endpointUrl'
  >,
): string {
  if (runtimeBindingBasis.deployment.kind === 'managedLocal') {
    return createProviderBindingSecurityFingerprintV1({
      ...sharedFingerprintInput,
      deployment: {
        kind: 'managedLocal',
        implementationIdentity:
          runtimeBindingBasis.deployment.implementationIdentity,
        managedRuntime: runtimeBindingBasis.deployment.managedRuntime,
      },
    });
  }
  if (!('normalizedUrl' in runtimeBindingBasis.endpoint)) {
    throw new TypeError('Expected external Provider runtime endpoint');
  }
  return createProviderBindingSecurityFingerprintV1({
    ...sharedFingerprintInput,
    endpointUrl: runtimeBindingBasis.endpoint.normalizedUrl,
  });
}

describe('resolveProviderAuthorizationApplyPolicyForActiveBinding', () => {
  it('allows an exact model-only change when the Agent proves live support', () => {
    expect(resolveApplyPolicyForObservedAuthorization({
      current: authorization('old'),
      next: authorization('next'),
    })).toBe('live');
  });

  it.each([
    ['endpoint URL', (next: ReturnType<typeof authorization>) => ({
      ...next,
      binding: {
        ...next.binding,
        endpoint: { ...next.binding.endpoint, normalizedUrl: 'https://other.example/v1' },
      },
    })],
    ['protocol', (next: ReturnType<typeof authorization>) => ({
      ...next,
      binding: {
        ...next.binding,
        endpoint: { ...next.binding.endpoint, protocol: 'openai-responses' as const },
      },
    })],
    ['public headers', (next: ReturnType<typeof authorization>) => ({
      ...next,
      binding: {
        ...next.binding,
        endpoint: { ...next.binding.endpoint, publicHeaders: { 'x-provider': 'changed' } },
      },
    })],
    ['materialization', (next: ReturnType<typeof authorization>) => ({
      ...next,
      prepared: { ...next.prepared, materialization: 'engineConfig' as const },
    })],
    ['credential destination', (next: ReturnType<typeof authorization>) => ({
      ...next,
      binding: {
        ...next.binding,
        runtimeCredentialTransport: {
          ...next.binding.runtimeCredentialTransport!,
          destination: {
            kind: 'httpHeader' as const,
            name: 'x-api-key',
            format: 'raw' as const,
          },
        },
      },
    })],
    ['adapter binding', (next: ReturnType<typeof authorization>) => ({
      ...next,
      prepared: { ...next.prepared, adapterBindingKey: 'other-adapter' },
    })],
    ['credential record', (next: ReturnType<typeof authorization>) => ({
      ...next,
      ticket: {
        ...next.ticket,
        selectedSecretRecordFingerprint: 'secret-record-b',
      },
    })],
  ] as const)('requires restart when the authorized %s changes', (_label, mutate) => {
    expect(resolveApplyPolicyForObservedAuthorization({
      current: authorization('old'),
      next: mutate(authorization('next')) as ReturnType<typeof authorization>,
    })).toBe('restart_session');
  });

  it('ignores display-only renames and object key order', () => {
    const next = authorization('next');
    expect(resolveApplyPolicyForObservedAuthorization({
      current: authorization('old'),
      next: {
        ...next,
        binding: {
          ...next.binding,
          endpoint: {
            ...next.binding.endpoint,
            publicHeaders: { b: '2', a: '1' },
          },
        },
        sessionBindingMetadata: {
          ...next.sessionBindingMetadata,
          displaySnapshot: {
            ...next.sessionBindingMetadata.displaySnapshot,
            connectionName: 'Renamed for display',
          },
        },
      },
    })).toBe('restart_session');

    const current = authorization('old');
    const currentWithHeaders = {
      ...current,
      binding: {
        ...current.binding,
        endpoint: {
          ...current.binding.endpoint,
          publicHeaders: { a: '1', b: '2' },
        },
      },
    };
    expect(resolveApplyPolicyForObservedAuthorization({
      current: currentWithHeaders,
      next: {
        ...next,
        binding: {
          ...next.binding,
          endpoint: {
            ...next.binding.endpoint,
            publicHeaders: { b: '2', a: '1' },
          },
        },
        sessionBindingMetadata: {
          ...next.sessionBindingMetadata,
          displaySnapshot: {
            ...next.sessionBindingMetadata.displaySnapshot,
            connectionName: 'Renamed for display',
          },
        },
      },
    })).toBe('live');
  });

  it('requires restart instead of silently adopting different managed-purpose facts', () => {
    expect(resolveApplyPolicyForObservedAuthorization({
      current: managedAuthorization('old', 'account-a'),
      next: managedAuthorization('next', 'account-a'),
    })).toBe('live');
    expect(resolveApplyPolicyForObservedAuthorization({
      current: managedAuthorization('old', 'account-a'),
      next: managedAuthorization('next', 'account-b'),
    })).toBe('restart_session');
  });

  it('requires restart when current settings no longer reproduce the active launch binding', () => {
    const launch = withRuntimeBindingBasis(authorization('old'));
    const currentBase = authorization('old');
    const current: ExternalAuthorization = {
      ...currentBase,
      binding: {
        ...currentBase.binding,
        endpoint: {
          ...currentBase.binding.endpoint,
          normalizedUrl: 'https://edited-after-launch.example/v1',
        },
      },
      bindingSecurityFingerprint: 'binding-security:edited-endpoint',
      ticket: {
        ...currentBase.ticket,
        bindingSecurityFingerprint: 'binding-security:edited-endpoint',
      },
      sessionBindingMetadata: {
        ...currentBase.sessionBindingMetadata,
        bindingSecurityFingerprint: 'binding-security:edited-endpoint',
      },
    };

    expect(resolveProviderAuthorizationApplyPolicyForActiveBinding({
      activeSelection: {
        agentTargetKey: launch.binding.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse(
          launch.binding.selection.connectionId,
        ),
        modelId: launch.binding.selection.model.id,
      },
      activeSessionBindingMetadata: launch.sessionBindingMetadata,
      next: {
        ...current,
        binding: {
          ...current.binding,
          selection: {
            ...current.binding.selection,
            model: { id: 'next', name: 'next' },
          },
        },
      },
    })).toBe('restart_session');
  });

  it('validates the managed launch purpose snapshot independently of future defaults', () => {
    const launch = withRuntimeBindingBasis(
      managedAuthorization('old', 'account-a'),
    );
    expect(resolveProviderAuthorizationApplyPolicyForActiveBinding({
      activeSelection: {
        agentTargetKey: launch.binding.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse(
          launch.binding.selection.connectionId,
        ),
        modelId: launch.binding.selection.model.id,
      },
      activeSessionBindingMetadata: launch.sessionBindingMetadata,
      next: managedAuthorization('next', 'account-a'),
    })).toBe('live');

    expect(resolveProviderAuthorizationApplyPolicyForActiveBinding({
      activeSelection: {
        agentTargetKey: launch.binding.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse(
          launch.binding.selection.connectionId,
        ),
        modelId: launch.binding.selection.model.id,
      },
      activeSessionBindingMetadata: launch.sessionBindingMetadata,
      next: managedAuthorization('next', 'account-b'),
    })).toBe('restart_session');

    const changedGrant = managedAuthorization('next', 'account-a');
    expect(resolveProviderAuthorizationApplyPolicyForActiveBinding({
      activeSelection: {
        agentTargetKey: launch.binding.agentTargetKey,
        providerConnectionId: ProviderConnectionIdSchema.parse(
          launch.binding.selection.connectionId,
        ),
        modelId: launch.binding.selection.model.id,
      },
      activeSessionBindingMetadata: launch.sessionBindingMetadata,
      next: {
        ...changedGrant,
        ticket: {
          ...changedGrant.ticket,
          connectionSecurityFingerprint: 'connection-security:changed',
          grantFingerprint: 'grant:changed',
        },
      },
    })).toBe('restart_session');
  });

  it('keeps equal persisted and current managed bindings live across canonical permutations', () => {
    const launch = withReversedManagedPurposeBindings(withRuntimeBindingBasis(
      managedAuthorization('old', 'account-a', ['ä-upstream', 'Z-upstream']),
    ));
    const next = withReversedManagedPurposeBindings(
      managedAuthorization('next', 'account-a', ['ä-upstream', 'Z-upstream']),
    );
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('localeCompare must not participate in Provider binding identity');
    };
    try {
      expect(resolveProviderAuthorizationApplyPolicyForActiveBinding({
        activeSelection: {
          agentTargetKey: launch.binding.agentTargetKey,
          providerConnectionId: ProviderConnectionIdSchema.parse(
            launch.binding.selection.connectionId,
          ),
          modelId: launch.binding.selection.model.id,
        },
        activeSessionBindingMetadata: launch.sessionBindingMetadata,
        next,
      })).toBe('live');
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it('treats managed connected-account declarations as a canonical set without hiding semantic changes', () => {
    const current = managedAuthorization(
      'old',
      'account-a',
      ['ä-upstream', 'Z-upstream'],
    );
    const reordered = withReversedManagedConnectedAccounts(
      managedAuthorization(
        'next',
        'account-a',
        ['ä-upstream', 'Z-upstream'],
      ),
    );
    const launch = withRuntimeBindingBasis(current);
    const changed = withChangedManagedConnectedAccountService(
      managedAuthorization(
        'next',
        'account-a',
        ['ä-upstream', 'Z-upstream'],
      ),
    );
    const retitled = withChangedManagedConnectedAccountTitle(
      managedAuthorization(
        'next',
        'account-a',
        ['ä-upstream', 'Z-upstream'],
      ),
    );
    const retitledRuntimeBinding = projectProviderRuntimeBindingBasis(retitled);
    if (retitledRuntimeBinding.deployment.kind !== 'managedLocal') {
      throw new TypeError('Expected a managed runtime binding');
    }
    expect(retitledRuntimeBinding.deployment.managedRuntime.connectedAccounts[0])
      .not.toHaveProperty('title');
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('localeCompare must not participate in Provider binding identity');
    };
    try {
      expect(sameProviderAuthorizationRuntimeBindingDimensions(
        current,
        reordered,
      )).toBe(true);
      expect(resolveApplyPolicyForObservedAuthorization({
        current,
        next: reordered,
      })).toBe('live');
      expect(resolveApplyPolicyForObservedAuthorization({
        current,
        next: retitled,
      })).toBe('live');
      expect(resolveProviderAuthorizationApplyPolicyForActiveBinding({
        activeSelection: {
          agentTargetKey: launch.binding.agentTargetKey,
          providerConnectionId: ProviderConnectionIdSchema.parse(
            launch.binding.selection.connectionId,
          ),
          modelId: launch.binding.selection.model.id,
        },
        activeSessionBindingMetadata: launch.sessionBindingMetadata,
        next: reordered,
      })).toBe('live');
      expect(resolveApplyPolicyForObservedAuthorization({
        current,
        next: changed,
      })).toBe('restart_session');
      expect(resolveApplyPolicyForObservedAuthorization({
        current,
        next: withChangedManagedConnectedAccountMaterializationKinds(reordered),
      })).toBe('restart_session');
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it('treats managed request-auth uses as a canonical set and restarts for descriptor drift', () => {
    const current = managedAuthorization(
      'old',
      'account-a',
      ['ä-upstream', 'Z-upstream'],
    );
    const reordered = withReversedManagedRequestAuthUses(
      managedAuthorization(
        'next',
        'account-a',
        ['ä-upstream', 'Z-upstream'],
      ),
    );
    expect(sameProviderAuthorizationRuntimeBindingDimensions(
      current,
      reordered,
    )).toBe(true);
    expect(resolveApplyPolicyForObservedAuthorization({
      current,
      next: reordered,
    })).toBe('live');
    expect(resolveApplyPolicyForObservedAuthorization({
      current,
      next: withChangedManagedRequestAuthOrigin(reordered),
    })).toBe('restart_session');
  });

  it('uses Protocol canonical order for managed request-auth header names', () => {
    const canonical = projectProviderRuntimeBindingBasis(
      withManagedRequestAuthHeaderNames(
        managedAuthorization('old', 'account-a'),
        ['authorization', 'x-trace-id'],
      ),
    );
    if (canonical.deployment.kind !== 'managedLocal') {
      throw new TypeError('Expected a managed runtime binding');
    }
    const reordered: ProviderRuntimeBindingBasisV1 = {
      ...canonical,
      deployment: {
        ...canonical.deployment,
        managedRuntime: {
          ...canonical.deployment.managedRuntime,
          requestAuthUses:
            canonical.deployment.managedRuntime.requestAuthUses.map((use) => ({
              ...use,
              materialization: {
                ...use.materialization,
                headerNames: [...use.materialization.headerNames].reverse(),
              },
            })),
        },
      },
    };
    const changed: ProviderRuntimeBindingBasisV1 = {
      ...canonical,
      deployment: {
        ...canonical.deployment,
        managedRuntime: {
          ...canonical.deployment.managedRuntime,
          requestAuthUses:
            canonical.deployment.managedRuntime.requestAuthUses.map((use) => ({
              ...use,
              materialization: {
                ...use.materialization,
                headerNames: ['authorization', 'x-request-id'],
              },
            })),
        },
      },
    };

    expect(sameProviderRuntimeBindingBasis(canonical, reordered)).toBe(true);
    expect(sameProviderRuntimeBindingBasis(canonical, changed)).toBe(false);
  });
});
