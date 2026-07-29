import { describe, expect, it } from 'vitest';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  deriveRegistryConnectedAccountPurposeAuthorizations,
  deriveRegistryConnectedAccountPurposeReconciliationScopes,
  deriveScmHostingProviderConnectedAccountPurposeAuthorization,
  type RegistryConnectedAccountPurposeAuthorizationProjection,
} from './deriveRegistryConnectedAccountPurposeAuthorizations';

function actionAndHookManifest() {
  const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
    id: 'acme.invocations',
    hostAccess: {
      required: [{
        id: 'action-account',
        capability: 'connectedAccounts',
        reason: 'Use action account',
        scope: {
          serviceRefs: ['account'],
          operations: ['use'],
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
        surfaces: ['cli'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
        hostAccess: ['logs', 'action-account'],
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
        managed: {
          connectedAccounts: [{
            purpose: 'provider-request',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          }],
        },
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

  it('derives one durable SCM hosting purpose from its qualified identity and auth service', () => {
    expect(deriveRegistryConnectedAccountPurposeAuthorizations(projection({
      scmHostingProviders: [{
        identity: {
          pluginId: 'happier.scm.hosting.github',
          localId: 'github',
        },
        definition: {
          id: 'github',
          authService: 'github-account',
        },
      }, {
        identity: {
          pluginId: 'happier.scm.hosting.bitbucket',
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
          pluginId: 'happier.scm.hosting.local',
          localId: 'local',
        },
        definition: {
          id: 'local',
        },
      }],
    }))).toEqual([
      {
        consumer: {
          pluginId: 'happier.scm.hosting.bitbucket',
          localId: 'bitbucket',
        },
        authorizedPurposes: [{
          purpose: {
            consumer: {
              pluginId: 'happier.scm.hosting.bitbucket',
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
          pluginId: 'happier.scm.hosting.github',
          localId: 'github',
        },
        authorizedPurposes: [{
          purpose: {
            consumer: {
              pluginId: 'happier.scm.hosting.github',
              localId: 'github',
            },
            purpose: 'authentication',
          },
          serviceRefs: [{
            pluginId: 'happier.scm.hosting.github',
            localId: 'github-account',
          }],
        }],
      },
    ]);
  });

  it('fails closed when an SCM hosting identity disagrees with its contribution id', () => {
    expect(() => deriveScmHostingProviderConnectedAccountPurposeAuthorization({
      identity: {
        pluginId: 'happier.scm.hosting.github',
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
          pluginId: 'happier.scm.hosting.github',
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
        pluginId: 'happier.scm.hosting.github',
        localId: 'github',
      },
      authorizedPurposes: [],
    }]);
  });

  it('keeps SCM consumer intent stable while reconciling a changed auth service scope', () => {
    const providerIdentity = {
      pluginId: 'happier.scm.hosting.github',
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

  it('contracts persisted consumers that have no previous runtime after a cold recovery', () => {
    expect(deriveRegistryConnectedAccountPurposeReconciliationScopes(
      null,
      projection(),
      [{ pluginId: 'acme.removed', localId: 'run' }],
    )).toEqual([{
      consumer: { pluginId: 'acme.removed', localId: 'run' },
      authorizedPurposes: [],
    }]);
  });
});
