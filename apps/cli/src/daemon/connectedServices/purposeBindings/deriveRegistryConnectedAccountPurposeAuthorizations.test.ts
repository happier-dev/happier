import { describe, expect, it, vi } from 'vitest';
import {
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/protocol';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';

import type { ConnectedAccountPurposeBindingOwner } from './ConnectedAccountPurposeBindingOwner';

import {
  deriveRegistryConnectedAccountPurposeAuthorizations,
  deriveRegistryConnectedAccountPurposeReconciliationScopes,
  deriveScmHostingProviderConnectedAccountPurposeAuthorization,
  revalidateRegistryConnectedAccountActionFormInput,
  resolveRegistryConnectedAccountActionPurposeBindingSnapshot,
  resolveRegistryConnectedAccountActionFormPurposeAuthorization,
  type RegistryConnectedAccountPurposeAuthorizationProjection,
} from './deriveRegistryConnectedAccountPurposeAuthorizations';

function actionAndHookManifest(options: Readonly<{ omitConnectedAccountOptionsField?: boolean }> = {}) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.invocations',
    hostAccess: {
      required: [{
        id: 'action-account',
        capability: 'connectedAccounts',
        reason: 'Use action account',
        scope: {
          serviceRefs: ['account'],
          operations: ['select', 'use'],
        },
      }, {
        id: 'logs',
        capability: 'network',
        reason: 'Read logs',
        scope: {
          targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }],
          methods: ['GET'],
        },
      }],
      optional: [{
        id: 'hook-account',
        capability: 'connectedAccounts',
        reason: 'Select hook account',
        scope: {
          serviceRefs: ['account'],
          operations: ['select', 'use'],
        },
      }],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'account',
        title: 'Account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
          }],
        },
      }],
      actions: [{
        id: 'run',
        title: 'Run',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['logs', 'action-account'],
        connectedAccountPurposeBindings: [{
          path: 'credentialRef',
          purpose: 'action-account',
        }],
        inputSchema: {
          type: 'object',
          properties: {
            credentialRef: {
              type: 'object',
              properties: {
                service: {
                  type: 'object',
                  properties: {
                    pluginId: { type: 'string' },
                    localId: { type: 'string' },
                  },
                  required: ['pluginId', 'localId'],
                  additionalProperties: false,
                },
                accountId: { type: 'string' },
              },
              required: ['service', 'accountId'],
              additionalProperties: false,
            },
          },
          required: ['credentialRef'],
          additionalProperties: false,
        },
        ...(options.omitConnectedAccountOptionsField ? {} : {
          inputHints: {
            fields: [{
              path: 'credentialRef',
              title: 'Connected Account',
              widget: 'select',
              connectedAccountOptions: true,
            }],
          },
        }),
      }],
      hooks: [{
        id: 'before-run',
        on: 'agent.resolvePrerequisites',
        category: 'decision',
        scope: 'agent',
        executionKind: 'decide',
        hostAccess: ['hook-account'],
      }],
    },
  }));
  if (!parsed) throw new Error('Expected canonical manifest fixture');
  return parsed;
}

function backgroundServiceManifest() {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.background',
    hostAccess: {
      required: [{
        id: 'required-account',
        capability: 'connectedAccounts',
        reason: 'Maintain the selected connection',
        scope: {
          serviceRefs: ['account'],
          operations: ['use'],
        },
      }],
      optional: [{
        id: 'selected-account',
        capability: 'connectedAccounts',
        reason: 'Use an optional selected connection',
        scope: {
          serviceRefs: ['account'],
          operations: ['select', 'use'],
        },
      }],
    },
    contributes: {
      backgroundServices: [{ id: 'gateway-supervisor' }],
      connectedAccountDescriptors: [{
        id: 'account',
        title: 'Account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
          }],
        },
      }],
    },
  }));
  if (!parsed) throw new Error('Expected canonical manifest fixture');
  return parsed;
}

function optionalActionManifest(input: Readonly<{
  operations: readonly ('select' | 'use')[];
  includeSecondSelect?: boolean;
  includeUseOnly?: boolean;
  omitPurposeBinding?: boolean;
}>) {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.optional-action',
    hostAccess: {
      required: [],
      optional: [{
        id: 'selected-account',
        capability: 'connectedAccounts',
        reason: 'Choose an Action account',
        scope: {
          serviceRefs: ['account'],
          operations: input.operations,
        },
      }, ...(input.includeSecondSelect ? [{
        id: 'second-selected-account',
        capability: 'connectedAccounts',
        reason: 'Choose another Action account',
        scope: {
          serviceRefs: ['account'],
          operations: ['select' as const],
        },
      }] : []), ...(input.includeUseOnly ? [{
        id: 'use-only-account',
        capability: 'connectedAccounts',
        reason: 'Use an Action account',
        scope: {
          serviceRefs: ['account'],
          operations: ['use' as const],
        },
      }] : [])],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'account',
        title: 'Account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
          }],
        },
      }],
      actions: [{
        id: 'run',
        title: 'Run',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: [
          'selected-account',
          ...(input.includeSecondSelect ? ['second-selected-account'] : []),
          ...(input.includeUseOnly ? ['use-only-account'] : []),
        ],
        ...(input.omitPurposeBinding ? {} : {
          connectedAccountPurposeBindings: [{
            path: 'credentialRef',
            purpose: 'selected-account',
          }],
        }),
        inputSchema: {
          type: 'object',
          properties: {
            credentialRef: {
              type: 'object',
              properties: {
                service: {
                  type: 'object',
                  properties: {
                    pluginId: { type: 'string' },
                    localId: { type: 'string' },
                  },
                  required: ['pluginId', 'localId'],
                  additionalProperties: false,
                },
                accountId: { type: 'string' },
              },
              required: ['service', 'accountId'],
              additionalProperties: false,
            },
          },
          required: ['credentialRef'],
          additionalProperties: false,
        },
        inputHints: {
          fields: [{
            path: 'credentialRef',
            title: 'Connected Account',
            widget: 'select',
            connectedAccountOptions: true,
          }],
        },
      }],
    },
  }));
  if (!parsed) throw new Error('Expected optional action manifest fixture');
  return parsed;
}

const qualifiedConnectedAccountRefSchema = {
  type: 'object',
  properties: {
    service: {
      type: 'object',
      properties: {
        pluginId: { type: 'string' },
        localId: { type: 'string' },
      },
      required: ['pluginId', 'localId'],
      additionalProperties: false,
    },
    accountId: { type: 'string' },
  },
  required: ['service', 'accountId'],
  additionalProperties: false,
} as const;

function historyGapSourceManifest() {
  const id = 'acme.history-gap';
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id,
    hostAccess: {
      required: [{
        id: 'source-account',
        capability: 'connectedAccounts',
        reason: 'Read the configured Event source',
        scope: {
          serviceRefs: ['account'],
          operations: ['use'],
        },
      }],
      optional: [],
    },
    contributes: {
      connectedAccountDescriptors: [{
        id: 'account',
        title: 'Account',
        authentication: {
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
          }],
        },
      }],
      actions: [{
        id: 'reset-history',
        title: 'Reset history',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        hostAccess: ['source-account'],
        inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
        resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
      }],
      events: [{
        id: 'repository-updated',
        kind: 'event',
        title: 'Repository updated',
        payloadSchema: { type: 'object', additionalProperties: false },
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: {
              type: 'object',
              properties: { credentialRef: qualifiedConnectedAccountRefSchema },
              required: ['credentialRef'],
              additionalProperties: false,
            },
            historyGapResetActionRef: { pluginId: id, localId: 'reset-history' },
            connectedAccountPurposeBindings: [{
              path: 'credentialRef',
              purpose: 'source-account',
            }],
          },
        },
      }],
    },
  }));
  if (!parsed) throw new Error('Expected canonical history-gap source manifest fixture');
  return parsed;
}

function projection(
  overrides: Partial<RegistryConnectedAccountPurposeAuthorizationProjection> = {},
): RegistryConnectedAccountPurposeAuthorizationProjection {
  return {
    agents: [],
    providers: [],
    activationTargets: [],
    ...overrides,
  };
}

describe('registry Connected Accounts purpose authorization projection', () => {
  it('derives exactly one authorized target Action Connected Account purpose from the declared field', () => {
    const manifest = actionAndHookManifest();
    const registry = projection({
      activationTargets: [{ pluginId: manifest.id, manifest }],
    });

    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      registry,
      qualifiedActionId: `${manifest.id}/run`,
      fieldPath: 'credentialRef',
    })).toEqual({
      action: { pluginId: manifest.id, localId: 'run' },
      purpose: {
        consumer: { pluginId: manifest.id, localId: 'run' },
        purpose: 'action-account',
      },
      serviceRefs: [{ pluginId: manifest.id, localId: 'account' }],
    });
    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      registry,
      qualifiedActionId: `${manifest.id}/run`,
      fieldPath: 'missing',
    })).toBeNull();
  });

  it('fails closed when the requested path is purpose-bound but declares no Connected Account form field', () => {
    // The requested fieldPath arrives from the client over the projection RPC,
    // not from the Action's own hints. An Action may bind a credential-ref
    // purpose without ever declaring a dynamic Connected Account form field,
    // and the host must not enumerate Accounts for a field the author never
    // declared.
    const manifest = actionAndHookManifest({ omitConnectedAccountOptionsField: true });
    const action = manifest.contributes?.actions?.find((entry) => entry.id === 'run');
    expect(action?.connectedAccountPurposeBindings).toEqual([
      { path: 'credentialRef', purpose: 'action-account' },
    ]);
    expect(action?.inputHints).toBeUndefined();

    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/run`,
      fieldPath: 'credentialRef',
    })).toBeNull();
  });

  it('requires the exact optional select grant and ignores a neighboring use-only request', () => {
    const manifest = optionalActionManifest({ operations: ['select', 'use'], includeUseOnly: true });
    const registry = projection({ activationTargets: [{ pluginId: manifest.id, manifest }] });
    const selectedRequest = manifest.hostAccess.optional.find((request) => request.id === 'selected-account')!;
    const exactSelection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: manifest.id,
      accessId: selectedRequest.id,
      capability: 'connectedAccounts',
      scope: selectedRequest.scope,
      selectedAtMs: 1,
    });
    const wrongSelection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: manifest.id,
      accessId: 'use-only-account',
      capability: 'connectedAccounts',
      scope: selectedRequest.scope,
      selectedAtMs: 1,
    });
    const input = {
      registry,
      qualifiedActionId: `${manifest.id}/run`,
      fieldPath: 'credentialRef',
    } as const;

    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization(input)).toBeNull();
    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      ...input,
      resolveOptionalAccess: (pluginId) => pluginId === manifest.id ? [wrongSelection] : [],
    })).toBeNull();
    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      ...input,
      resolveOptionalAccess: (pluginId) => pluginId === manifest.id ? [exactSelection] : [],
    })).toMatchObject({
      purpose: { purpose: 'selected-account' },
      serviceRefs: [{ pluginId: manifest.id, localId: 'account' }],
    });
  });

  it('does not enumerate a use-only Connected Account request', () => {
    const manifest = optionalActionManifest({ operations: ['use'] });
    const registry = projection({ activationTargets: [{ pluginId: manifest.id, manifest }] });
    const request = manifest.hostAccess.optional[0]!;
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: manifest.id,
      accessId: request.id,
      capability: 'connectedAccounts',
      scope: request.scope,
      selectedAtMs: 1,
    });

    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      registry,
      qualifiedActionId: `${manifest.id}/run`,
      fieldPath: 'credentialRef',
      resolveOptionalAccess: () => [selection],
    })).toBeNull();
  });

  it('uses the typed credential-reference mapping even when another select request is declared', () => {
    const manifest = optionalActionManifest({ operations: ['select', 'use'], includeSecondSelect: true });
    const registry = projection({ activationTargets: [{ pluginId: manifest.id, manifest }] });
    const selectedRequest = manifest.hostAccess.optional.find((request) => request.id === 'selected-account')!;
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: manifest.id,
      accessId: selectedRequest.id,
      capability: 'connectedAccounts',
      scope: selectedRequest.scope,
      selectedAtMs: 1,
    });

    expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({
      registry,
      qualifiedActionId: `${manifest.id}/run`,
      fieldPath: 'credentialRef',
      resolveOptionalAccess: () => [selection],
    })).toMatchObject({
      purpose: { purpose: 'selected-account' },
      serviceRefs: [{ pluginId: manifest.id, localId: 'account' }],
    });
  });

  it('resolves the typed mapped purpose instead of inferring from multiple select requests', async () => {
    const manifest = optionalActionManifest({ operations: ['select', 'use'], includeSecondSelect: true });
    const selectedRequest = manifest.hostAccess.optional.find((request) => request.id === 'selected-account')!;
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: manifest.id,
      accessId: selectedRequest.id,
      capability: 'connectedAccounts',
      scope: selectedRequest.scope,
      selectedAtMs: 1,
    });
    const resolveBindingIntent = vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(async (input) => ({
      purpose: input.purpose,
      target: input.target,
    }));

    await expect(revalidateRegistryConnectedAccountActionFormInput({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/run`,
      value: {
        credentialRef: {
          service: { pluginId: manifest.id, localId: 'account' },
          accountId: 'account-1',
        },
      },
      resolveOptionalAccess: () => [selection],
      actionFormConnectedAccounts: { resolveBindingIntent },
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toBeNull();
    expect(resolveBindingIntent).toHaveBeenCalledWith(expect.objectContaining({
      purpose: {
        consumer: { pluginId: manifest.id, localId: 'run' },
        purpose: 'selected-account',
      },
    }));
  });

  it('fails closed when a dynamic credential-ref field has no typed purpose mapping', async () => {
    const manifest = optionalActionManifest({ operations: ['select'], omitPurposeBinding: true });
    const resolveBindingIntent = vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(async () => {
      throw new Error('resolveBindingIntent must not run without a typed mapping');
    });

    await expect(revalidateRegistryConnectedAccountActionFormInput({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/run`,
      value: {
        credentialRef: {
          service: { pluginId: manifest.id, localId: 'account' },
          accountId: 'account-1',
        },
      },
      actionFormConnectedAccounts: { resolveBindingIntent },
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_form_connected_account_options_unavailable',
      message: 'The selected Connected Account is no longer available for this Action form',
    });
    expect(resolveBindingIntent).not.toHaveBeenCalled();
  });

  it('returns typed unavailable and never dispatches Account resolution when a dynamic field has zero select purposes', async () => {
    const manifest = optionalActionManifest({ operations: ['use'] });
    const resolveBindingIntent = vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(async () => {
      throw new Error('resolveBindingIntent must not run without a select purpose');
    });

    await expect(revalidateRegistryConnectedAccountActionFormInput({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/run`,
      value: {
        credentialRef: {
          service: { pluginId: manifest.id, localId: 'account' },
          accountId: 'account-1',
        },
      },
      actionFormConnectedAccounts: { resolveBindingIntent },
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_form_connected_account_options_unavailable',
      message: 'The selected Connected Account is no longer available for this Action form',
    });
    expect(resolveBindingIntent).not.toHaveBeenCalled();
  });

  it('converts a stale canonical Account binding into typed unavailable without exposing the binding error', async () => {
    const manifest = actionAndHookManifest();
    const resolveBindingIntent = vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(async () => {
      throw Object.assign(new Error('account-1 was deleted'), {
        name: 'PluginError',
        code: 'plugin_host_access_resource_not_selected',
      });
    });

    await expect(revalidateRegistryConnectedAccountActionFormInput({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/run`,
      value: {
        credentialRef: {
          service: { pluginId: manifest.id, localId: 'account' },
          accountId: 'deleted-account',
        },
      },
      actionFormConnectedAccounts: { resolveBindingIntent },
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_form_connected_account_options_unavailable',
      message: 'The selected Connected Account is no longer available for this Action form',
    });
    expect(resolveBindingIntent).toHaveBeenCalledOnce();
  });

  it('binds the exact Account from the revalidated history-gap source, not a durable selection', async () => {
    const manifest = historyGapSourceManifest();
    const sourceAccount = {
      service: { pluginId: manifest.id, localId: 'account' },
      accountId: 'source-account-a',
    };
    const resolveBindingIntent = vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(
      async (input) => ({ purpose: input.purpose, target: input.target }),
    );
    const resolveSource = vi.fn(async () => Object.freeze({
      eventLocalId: 'repository-updated',
      sourceConfig: { credentialRef: sourceAccount },
    }));

    await expect(resolveRegistryConnectedAccountActionPurposeBindingSnapshot({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/reset-history`,
      value: {
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      },
      actionFormConnectedAccounts: { resolveBindingIntent },
      resolveAutomationEventHistoryGapSource: resolveSource,
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toEqual({
      purposes: [{
        consumer: { pluginId: manifest.id, localId: 'reset-history' },
        purpose: 'source-account',
      }],
      bindings: [{
        purpose: {
          consumer: { pluginId: manifest.id, localId: 'reset-history' },
          purpose: 'source-account',
        },
        target: { kind: 'account', account: sourceAccount },
      }],
    });
    expect(resolveSource).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: manifest.id,
      eventLocalIds: ['repository-updated'],
      reset: {
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      },
    }));
    expect(resolveBindingIntent).toHaveBeenCalledWith(expect.objectContaining({
      purpose: {
        consumer: { pluginId: manifest.id, localId: 'reset-history' },
        purpose: 'source-account',
      },
      target: { kind: 'account', account: sourceAccount },
    }));
  });

  it('refuses a history-gap source returned outside the declared reset Event', async () => {
    const manifest = historyGapSourceManifest();
    const resolveBindingIntent = vi.fn<ConnectedAccountPurposeBindingOwner['resolveBindingIntent']>(async () => {
      throw new Error('An arbitrary listed source must not be materialized');
    });

    await expect(resolveRegistryConnectedAccountActionPurposeBindingSnapshot({
      registry: projection({ activationTargets: [{ pluginId: manifest.id, manifest }] }),
      qualifiedActionId: `${manifest.id}/reset-history`,
      value: {
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
      },
      actionFormConnectedAccounts: { resolveBindingIntent },
      resolveAutomationEventHistoryGapSource: async () => ({
        eventLocalId: 'unrelated-event',
        sourceConfig: {
          credentialRef: {
            service: { pluginId: manifest.id, localId: 'account' },
            accountId: 'listed-account-b',
          },
        },
      }),
      signal: new AbortController().signal,
      isCurrent: () => true,
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_history_gap_source_unavailable',
    });
    expect(resolveBindingIntent).not.toHaveBeenCalled();
  });

  it('derives a managed Provider purpose from an external public declaration and runtime', () => {
    const provider = {
      provenance: 'external',
      source: { kind: 'path' },
      pluginId: 'acme.provider.gateway',
      identity: { pluginId: 'acme.provider.gateway', localId: 'gateway' },
      definition: {
        v: 1,
        id: 'gateway',
        name: 'Acme Gateway',
        kind: 'aggregator',
        endpointTemplates: [{
          id: 'api',
          protocol: 'openai-responses',
          baseUrl: 'https://gateway.example.test/v1',
          capabilities: {
            streaming: 'supported',
            toolRoundTrips: 'supported',
            statefulResponses: 'unknown',
            reasoningControls: 'supported',
          },
        }],
        catalog: {
          source: 'static',
          manualModelPolicy: 'allowed',
          staticModels: [{ id: 'example', name: 'Example' }],
        },
        managedRuntime: {
          kind: 'managed',
          connectedAccounts: [{
            purpose: 'upstream',
            service: {
              pluginId: 'acme.accounts.gateway',
              localId: 'subscription',
            },
            required: true,
            materializationKinds: ['httpHeaders'],
          }],
          endpointTemplateIds: ['api'],
        },
      },
      managedRuntime: {
        runtime: {
          start: () => Promise.reject(new Error('Managed runtime must not start during projection')),
        },
        activationGeneration: '7',
        immutableGenerationId: 'immutable:acme-provider-gateway',
        isCurrent: () => true,
      },
    } satisfies ResolvedProviderContribution;

    expect(deriveRegistryConnectedAccountPurposeAuthorizations(projection({
      providers: [provider],
    }))).toEqual([{
      consumer: { pluginId: 'acme.provider.gateway', localId: 'gateway' },
      authorizedPurposes: [{
        purpose: {
          consumer: { pluginId: 'acme.provider.gateway', localId: 'gateway' },
          purpose: 'upstream',
        },
        serviceRefs: [{
          pluginId: 'acme.accounts.gateway',
          localId: 'subscription',
        }],
      }],
    }]);
  });

  it('derives qualified Agent, managed Provider, action, and hook purposes from canonical declarations', () => {
    const pluginManifest = actionAndHookManifest();
    const optionalSelection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: pluginManifest.id,
      accessId: 'hook-account',
      capability: 'connectedAccounts',
      scope: pluginManifest.hostAccess.optional[0]!.scope,
      selectedAtMs: 1,
    });

    expect(deriveRegistryConnectedAccountPurposeAuthorizations(projection({
      agents: [{
        id: 'codex',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        richDefinition: {
          definition: {
            connectedAccounts: [{
              purpose: 'model-request',
              service: 'openai-codex',
            }],
          },
        },
      }],
      providers: [{
        provenance: 'first_party',
        identity: { pluginId: 'happier.provider.openai', localId: 'openai' },
        definition: {
          managedRuntime: {
            connectedAccounts: [{
              purpose: 'provider-request',
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            }],
          },
        },
        managedRuntime: { runtime: {} },
      }],
      activationTargets: [{
        pluginId: pluginManifest.id,
        manifest: pluginManifest,
      }],
    }), () => [optionalSelection])).toEqual([
      {
        consumer: { pluginId: 'acme.invocations', localId: 'before-run' },
        authorizedPurposes: [{
          purpose: {
            consumer: { pluginId: 'acme.invocations', localId: 'before-run' },
            purpose: 'hook-account',
          },
          serviceRefs: [{ pluginId: 'acme.invocations', localId: 'account' }],
        }],
      },
      {
        consumer: { pluginId: 'acme.invocations', localId: 'run' },
        authorizedPurposes: [{
          purpose: {
            consumer: { pluginId: 'acme.invocations', localId: 'run' },
            purpose: 'action-account',
          },
          serviceRefs: [{ pluginId: 'acme.invocations', localId: 'account' }],
        }],
      },
      {
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
        authorizedPurposes: [{
          purpose: {
            consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
            purpose: 'model-request',
          },
          serviceRefs: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }],
        }],
      },
      {
        consumer: { pluginId: 'happier.provider.openai', localId: 'openai' },
        authorizedPurposes: [{
          purpose: {
            consumer: { pluginId: 'happier.provider.openai', localId: 'openai' },
            purpose: 'provider-request',
          },
          serviceRefs: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }],
        }],
      },
    ]);
  });

  it('projects the full background HostAccess declaration through its durable consumer', () => {
    const pluginManifest = backgroundServiceManifest();
    const optionalSelection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: pluginManifest.id,
      accessId: 'selected-account',
      capability: 'connectedAccounts',
      scope: pluginManifest.hostAccess.optional[0]!.scope,
      selectedAtMs: 1,
    });
    const registry = projection({
      activationTargets: [{
        pluginId: pluginManifest.id,
        manifest: pluginManifest,
      }],
    });

    expect(deriveRegistryConnectedAccountPurposeAuthorizations(registry)).toEqual([{
      consumer: { pluginId: 'acme.background', localId: 'gateway-supervisor' },
      authorizedPurposes: [{
        purpose: {
          consumer: { pluginId: 'acme.background', localId: 'gateway-supervisor' },
          purpose: 'required-account',
        },
        serviceRefs: [{ pluginId: 'acme.background', localId: 'account' }],
      }],
    }]);
    expect(deriveRegistryConnectedAccountPurposeAuthorizations(
      registry,
      () => [optionalSelection],
    )).toEqual([{
      consumer: { pluginId: 'acme.background', localId: 'gateway-supervisor' },
      authorizedPurposes: [{
        purpose: {
          consumer: { pluginId: 'acme.background', localId: 'gateway-supervisor' },
          purpose: 'required-account',
        },
        serviceRefs: [{ pluginId: 'acme.background', localId: 'account' }],
      }, {
        purpose: {
          consumer: { pluginId: 'acme.background', localId: 'gateway-supervisor' },
          purpose: 'selected-account',
        },
        serviceRefs: [{ pluginId: 'acme.background', localId: 'account' }],
      }],
    }]);
  });

  it('derives one durable SCM hosting purpose from its qualified identity and auth service', () => {
    expect(deriveRegistryConnectedAccountPurposeAuthorizations(projection({
      scmHostingProviders: [{
        identity: {
          pluginId: 'happier.scm.forge.github',
          localId: 'github',
        },
        definition: {
          id: 'github',
          authService: 'github-account',
        },
      }, {
        identity: {
          pluginId: 'happier.scm.forge.bitbucket',
          localId: 'bitbucket',
        },
        definition: {
          id: 'bitbucket',
          authService: {
            pluginId: 'happier.accounts.atlassian',
            localId: 'bitbucket-account',
          },
        },
      }, {
        identity: {
          pluginId: 'happier.scm.forge.local',
          localId: 'local',
        },
        definition: {
          id: 'local',
        },
      }],
    }))).toEqual([
      {
        consumer: {
          pluginId: 'happier.scm.forge.bitbucket',
          localId: 'bitbucket',
        },
        authorizedPurposes: [{
          purpose: {
            consumer: {
              pluginId: 'happier.scm.forge.bitbucket',
              localId: 'bitbucket',
            },
            purpose: 'authentication',
          },
          serviceRefs: [{
            pluginId: 'happier.accounts.atlassian',
            localId: 'bitbucket-account',
          }],
        }],
      },
      {
        consumer: {
          pluginId: 'happier.scm.forge.github',
          localId: 'github',
        },
        authorizedPurposes: [{
          purpose: {
            consumer: {
              pluginId: 'happier.scm.forge.github',
              localId: 'github',
            },
            purpose: 'authentication',
          },
          serviceRefs: [{
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
          }],
        }],
      },
    ]);
  });

  it('fails closed when an SCM hosting identity disagrees with its contribution id', () => {
    expect(() => deriveScmHostingProviderConnectedAccountPurposeAuthorization({
      identity: {
        pluginId: 'happier.scm.forge.github',
        localId: 'other-provider',
      },
      definition: {
        id: 'github',
        authService: 'github-account',
      },
    })).toThrow('connected_account_scm_hosting_purpose_consumer_identity_mismatch');
  });

  it('contracts revoked optional requests, preserves required requests, and fails closed for narrower selections', () => {
    const pluginManifest = actionAndHookManifest();
    const activationTargets = [{
      pluginId: pluginManifest.id,
      manifest: pluginManifest,
    }];
    const optionalRequest = pluginManifest.hostAccess.optional[0]!;
    if (optionalRequest.capability !== 'connectedAccounts') {
      throw new Error('Expected a connectedAccounts optional request');
    }
    const requestedScope = optionalRequest.scope;
    if (requestedScope.serviceRefs.length !== 1 || requestedScope.operations.length !== 2) {
      throw new Error('Expected the optional fixture to have a narrowable operation set');
    }
    const narrowerSelection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: pluginManifest.id,
      accessId: 'hook-account',
      capability: 'connectedAccounts',
      scope: {
        ...requestedScope,
        operations: ['select'],
      },
      selectedAtMs: 1,
    });

    expect(deriveRegistryConnectedAccountPurposeAuthorizations(
      projection({ activationTargets }),
      () => [],
    )).toEqual([
      {
        consumer: { pluginId: 'acme.invocations', localId: 'before-run' },
        authorizedPurposes: [],
      },
      {
        consumer: { pluginId: 'acme.invocations', localId: 'run' },
        authorizedPurposes: [{
          purpose: {
            consumer: { pluginId: 'acme.invocations', localId: 'run' },
            purpose: 'action-account',
          },
          serviceRefs: [{ pluginId: 'acme.invocations', localId: 'account' }],
        }],
      },
    ]);
    expect(deriveRegistryConnectedAccountPurposeAuthorizations(
      projection({ activationTargets }),
      () => [narrowerSelection],
    )).toEqual([
      {
        consumer: { pluginId: 'acme.invocations', localId: 'before-run' },
        authorizedPurposes: [],
      },
      {
        consumer: { pluginId: 'acme.invocations', localId: 'run' },
        authorizedPurposes: [{
          purpose: {
            consumer: { pluginId: 'acme.invocations', localId: 'run' },
            purpose: 'action-account',
          },
          serviceRefs: [{ pluginId: 'acme.invocations', localId: 'account' }],
        }],
      },
    ]);
  });

  it('includes removed previous consumers with an empty candidate scope', () => {
    const previous = projection({
      agents: [{
        id: 'codex',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        richDefinition: {
          definition: {
            connectedAccounts: [{
              purpose: 'model-request',
              service: 'openai-codex',
            }],
          },
        },
      }],
    });

    expect(deriveRegistryConnectedAccountPurposeReconciliationScopes(
      previous,
      projection(),
    )).toEqual([{
      consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
      authorizedPurposes: [],
    }]);
  });

  it('contracts an SCM hosting binding when its authentication service declaration is removed', () => {
    const previous = projection({
      scmHostingProviders: [{
        identity: {
          pluginId: 'happier.scm.forge.github',
          localId: 'github',
        },
        definition: {
          id: 'github',
          authService: 'github-account',
        },
      }],
    });

    expect(deriveRegistryConnectedAccountPurposeReconciliationScopes(
      previous,
      projection(),
    )).toEqual([{
      consumer: {
        pluginId: 'happier.scm.forge.github',
        localId: 'github',
      },
      authorizedPurposes: [],
    }]);
  });

  it('keeps SCM consumer intent stable while reconciling a changed auth service scope', () => {
    const providerIdentity = {
      pluginId: 'happier.scm.forge.github',
      localId: 'github',
    } as const;
    const previous = projection({
      scmHostingProviders: [{
        identity: providerIdentity,
        definition: {
          id: 'github',
          authService: 'github-account',
        },
      }],
    });
    const candidate = projection({
      scmHostingProviders: [{
        identity: providerIdentity,
        definition: {
          id: 'github',
          authService: {
            pluginId: 'happier.accounts.github',
            localId: 'enterprise',
          },
        },
      }],
    });

    expect(deriveRegistryConnectedAccountPurposeReconciliationScopes(
      previous,
      candidate,
    )).toEqual([{
      consumer: providerIdentity,
      authorizedPurposes: [{
        purpose: {
          consumer: providerIdentity,
          purpose: 'authentication',
        },
        serviceRefs: [{
          pluginId: 'happier.accounts.github',
          localId: 'enterprise',
        }],
      }],
    }]);
  });

});
