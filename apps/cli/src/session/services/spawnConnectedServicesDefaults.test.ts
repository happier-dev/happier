import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { teamCredentialDisplayNamePrivateLabelBindingV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import {
  createSpawnConnectedServicesTeamResourceCatalogResolver,
  mergeSessionTeamCredentialBindingIntents,
  resolvePurposeTeamCredentialBindingIntents,
  resolvePurposeTeamCredentialBindingIntentsFromHome,
  resolveSpawnConnectedServicesDefaultDisposition,
  resolveSpawnConnectedServicesDefaults,
  resolveSessionSpawnConnectedServicesDefaultsPayload,
} from './spawnConnectedServicesDefaults';

// Codex's real declared purpose, read from the bundled contribution projection.
const CODEX_SCOPE = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
  agentId: 'codex',
  contributions: readCurrentContributionRegistry(),
})?.authorizedPurposes.find((scope) => scope.serviceRefs[0]?.localId === 'openai-codex');
const CODEX_CONSUMER = CODEX_SCOPE?.purpose.consumer ?? { pluginId: 'missing', localId: 'missing' };
const CODEX_PURPOSE = CODEX_SCOPE?.purpose.purpose ?? 'missing';

// Selected bindings stay exact; newly declared services retain native fallback.
const nativeBindingsForAgent = (agentId: string) => Object.fromEntries(
  resolveCatalogAgentConnectedAccountServiceIds(agentId).map(serviceId => [serviceId, { source: 'native' as const }]),
);

function resourceDisplayName(resourceId: string, value: string) {
  return projectPrivateLabelForRecipientV1({
    stored: sealPrivateLabelV1({ mode: 'plain', binding: teamCredentialDisplayNamePrivateLabelBindingV1(resourceId), value }),
    recipientAccountId: 'recipient-account',
  });
}

describe('resolveSpawnConnectedServicesDefaults', () => {
  it('uses the retained authored Agent for Account defaults without installing it in the ambient catalog', async () => {
    const pluginId = 'acme.retained-defaults';
    const definition = PluginAgentContributionV2Schema.parse({
      id: 'child', title: 'Retained child', runtime: { kind: 'custom' }, primary: 'executionRuns',
      capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
      connectedAccounts: [{ purpose: 'model', service: { pluginId, localId: 'subscription' },
        materializationKinds: ['environment'], credentialKinds: ['token'] }],
    });
    const agent = projectManifestAgentContribution({
      pluginId, definition, provenance: 'external', source: { kind: 'path' },
    });
    const contributions = createResolvedContributionRegistry({ agents: [agent] });
    const catalogEntry = contributions.catalogEntriesById[agent.id];
    const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: agent.id, contributions, catalogEntry,
    })?.authorizedPurposes[0];
    if (!scope || !catalogEntry) throw new Error('Expected the authored child purpose and catalog entry');
    expect(readCurrentContributionRegistry().agentDefinitionsById.has(agent.id)).toBe(false);

    const credentials = { token: 'retained-child-default', encryption: null };
    const serverHttpBaseUrl = 'https://retained-defaults.example';
    // Only Home HTTP is replaced; bootstrap, purpose declarations, catalog opening,
    // Account selection and Session binding materialization all stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/account/settings') return { status: 200,
        data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 3, content: { t: 'plain', v: { key: 'purposes', value: {
          v: 1, bindings: [{ purpose: scope.purpose, target: { kind: 'account',
            account: { service: scope.serviceRefs[0], accountId: 'selected-account' } } }],
        } } },
      } };
      return { status: 404, data: { error: 'unsupported' } };
    });
    try {
      const payload = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => {
        const operationContext = createInvocationSavedSecretOperationContextV1({
          credentials, serverHttpBaseUrl,
          snapshot: { source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1,
            settingsVersion: 7, settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [] },
          isCurrent: async () => true,
        });
        return resolveSessionSpawnConnectedServicesDefaultsPayload({
          agentId: agent.id, credentials, contributions, catalogEntry, operationContext,
        });
      });
      expect(payload?.connectedServices).toEqual({ v: 2, bindingsByServiceId: {
        [`${pluginId}/subscription`]: { source: 'connected', selection: 'profile', profileId: 'selected-account' },
      } });
      expect(readCurrentContributionRegistry().agentDefinitionsById.has(agent.id)).toBe(false);
    } finally {
      get.mockRestore();
    }
  });

  it('classifies a no-longer-offered Team purpose default with the canonical resource refusal', async () => {
    if (!CODEX_SCOPE) throw new Error('Expected real Codex purpose declaration');
    let reads = 0;
    const resolver = createSpawnConnectedServicesTeamResourceCatalogResolver({ serverId: 'home', accountId: 'recipient',
      homeDomainAction: async () => { reads++; return { resources: [], nextCursor: null }; } });
    await expect(resolvePurposeTeamCredentialBindingIntentsFromHome({
      teamResourceSelections: [{ purpose: CODEX_SCOPE.purpose, services: CODEX_SCOPE.serviceRefs,
        teamId: 'team-a', selection: { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' } }],
      resolveTeamCredentialResourceCatalog: resolver,
    })).rejects.toMatchObject({ code: 'resource_unavailable', phase: 'purpose_binding',
      reason: 'connected_services_team_default_requires_current_resource' });
    expect(reads).toBe(1);
  });
  it.each(['resource_forbidden', 'connected_service_credential_reconnect_required'])(
    'keeps the %s reason when resolving a purpose default through Home', async code => {
      if (!CODEX_SCOPE) throw new Error('Expected real Codex purpose declaration');
      let reads = 0;
      const resolver = createSpawnConnectedServicesTeamResourceCatalogResolver({ serverId: 'home', accountId: 'recipient',
        homeDomainAction: async () => { reads++; return { ok: false, error: { code } }; } });
      await expect(resolvePurposeTeamCredentialBindingIntentsFromHome({
        teamResourceSelections: [{ purpose: CODEX_SCOPE.purpose, services: CODEX_SCOPE.serviceRefs,
          teamId: 'team-a', selection: { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' } }],
        resolveTeamCredentialResourceCatalog: resolver,
      })).rejects.toMatchObject({ code, phase: 'resource_catalog' });
      expect(reads).toBe(1);
    },
  );
  it('reads every recipient-catalog continuation before resolving a Team default', async () => {
    const resource = {
      id: 'resource-page-two', teamId: 'team-a', displayName: resourceDisplayName('resource-page-two', 'Page two'), resourceRevision: 1, sourceOwnerDisplayName: null,
      readiness: { kind: 'available' as const }, recoveryAction: null,
      mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
      sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
      connectedServiceSelections: [{ source: 'team_resource' as const, resourceId: 'resource-page-two', deliveryMode: 'brokered' as const }],
      sourcePresentation: {
        kind: 'connected_service' as const,
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      },
    };
    const homeDomainAction = vi.fn()
      .mockResolvedValueOnce({ resources: [], nextCursor: 'recipient-page-2' })
      .mockResolvedValueOnce({ resources: [resource], nextCursor: null });

    await expect(createSpawnConnectedServicesTeamResourceCatalogResolver({
      homeDomainAction, serverId: 'home-a', accountId: 'account-a',
    })({ teamIds: ['team-a'] })).resolves.toEqual({
      serverId: 'home-a', accountId: 'account-a', resources: [resource],
    });
    expect(homeDomainAction).toHaveBeenNthCalledWith(2, {
      actionId: 'teams.credentials.entitled.list',
      input: { teamId: 'team-a', cursor: 'recipient-page-2' },
      context: { surface: 'cli', serverId: 'home-a' },
    });
  });

  it('preserves an exact connected group selection while availability is deferred to the daemon', () => {
    expect(resolveSpawnConnectedServicesDefaults({
      agentId: 'claude',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            claude: {
              v: 1,
              bindingsByServiceId: {
                'claude-subscription': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                },
              },
            },
          },
        },
      },
    })).toEqual({
      v: 2,
      bindingsByServiceId: {
        ...nativeBindingsForAgent('claude'),
        'happier.agent.claude/claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'team',
        },
      },
    });
  });

  it('preserves protocol-tolerant native fallback for a malformed persisted default blob', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {},
    })).toEqual({ kind: 'native' });
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: { v: 999 },
      },
    })).toEqual({ kind: 'native' });
  });

  it('fails typed instead of falling back to native for a Team resource default without a current catalog', () => {
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            codex: {
              v: 2,
              bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                  source: 'team_resource',
                  serverId: 'home-a',
                  accountId: 'recipient-account',
                  teamId: 'team-a',
                  resourceId: 'resource-a',
                  expectedResourceRevision: 7,
                  deliveryMode: 'brokered',
                },
              },
            },
          },
        },
      },
    })).toEqual({
      kind: 'unavailable',
      reason: 'connected_services_team_default_requires_current_resource',
    });
  });

  it('resolves an exact fresh Team resource default through the current recipient catalog', () => {
    const settings = {
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 2,
            bindingsByServiceId: {
              'happier.agent.codex/openai-codex': {
                source: 'team_resource', serverId: 'home-a', accountId: 'recipient-account',
                teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
                deliveryMode: 'brokered',
              },
            },
          },
        },
      },
    };
    const catalog = {
      serverId: 'home-a',
      accountId: 'recipient-account',
      resources: [{
        id: 'resource-a', teamId: 'team-a', displayName: resourceDisplayName('resource-a', 'Shared Codex account'), sourceOwnerDisplayName: null,
        resourceRevision: 7, readiness: { kind: 'available' as const }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
        sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
        connectedServiceSelections: [{
          source: 'team_resource' as const, resourceId: 'resource-a', deliveryMode: 'brokered' as const,
        }],
        sourcePresentation: {
          kind: 'connected_service' as const,
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
    };

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex', accountSettings: settings, teamCredentialResourceCatalog: catalog,
    })).toEqual({
      kind: 'connected',
      bindings: {
        v: 2,
        bindingsByServiceId: {
          ...nativeBindingsForAgent('codex'),
          'happier.agent.codex/openai-codex': {
            source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered',
          },
        },
      },
    });

    // A default is a reference, not an entitlement (lane 10 child 02 §11.6):
    // a harmless resource edit does not strand it. The Session's own binding
    // intent carries the current revision to the Home.
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: settings,
      teamCredentialResourceCatalog: {
        ...catalog,
        resources: [{ ...catalog.resources[0]!, resourceRevision: 8 }],
      },
    })).toMatchObject({ kind: 'connected' });
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: settings,
      teamCredentialResourceCatalog: {
        ...catalog,
        resources: [{ ...catalog.resources[0]!, teamId: 'team-other' }],
      },
    })).toEqual({
      kind: 'unavailable',
      reason: 'connected_services_team_default_requires_current_resource',
    });

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings: settings,
      teamCredentialResourceCatalog: {
        ...catalog,
        resources: [{ ...catalog.resources[0]!, readiness: { kind: 'policy_denied' as const } }],
      },
    })).toEqual({
      kind: 'unavailable',
      reason: 'policy_denied',
    });
  });

  const agentPageTeamSelection = { source: 'team_resource' as const, resourceId: 'resource-a', deliveryMode: 'brokered' as const };
  it.each([
    {
      // What the Agent page chooser persists now: the canonical Team selection.
      label: 'the canonical Team selection',
      purposeBindings: {
        v: 1,
        bindings: [],
        teamResourceSelections: [{
          purpose: { consumer: CODEX_CONSUMER, purpose: CODEX_PURPOSE },
          teamId: 'team-a',
          selection: agentPageTeamSelection,
        }],
      },
    },
    {
      // What an earlier 0.3 build persisted, read forward.
      label: 'an earlier 0.3 Team purpose target',
      purposeBindings: {
        v: 1,
        bindings: [{
          purpose: { consumer: CODEX_CONSUMER, purpose: CODEX_PURPOSE },
          target: {
            kind: 'team_resource',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            teamId: 'team-a',
            selection: agentPageTeamSelection,
          },
        }],
      },
    },
  ])('spawns with the Team default chosen on the Agent page, stored as $label', ({ purposeBindings }) => {
    const selection = agentPageTeamSelection;
    const purposeCatalog = { status: 'ready' as const, revision: 4,
      record: { key: 'purposes' as const,
        value: ConnectedPurposeCatalogV1Schema.parse(QualifiedConnectedAccountPurposeBindingsV1Schema.parse(purposeBindings)) } };
    const catalog = {
      serverId: 'home-a',
      accountId: 'recipient-account',
      resources: [{
        id: 'resource-a', teamId: 'team-a', displayName: resourceDisplayName('resource-a', 'Shared Codex account'), sourceOwnerDisplayName: null,
        resourceRevision: 7, readiness: { kind: 'available' as const }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
        sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
        connectedServiceSelections: [selection],
        sourcePresentation: {
          kind: 'connected_service' as const,
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
    };

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex', accountSettings: {}, purposeCatalog, teamCredentialResourceCatalog: catalog,
    })).toEqual({
      kind: 'connected',
      bindings: { v: 2, bindingsByServiceId: { ...nativeBindingsForAgent('codex'), 'happier.agent.codex/openai-codex': selection } },
    });
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex', accountSettings: {}, purposeCatalog,
      teamCredentialResourceCatalog: { ...catalog, resources: catalog.resources.map(resource => ({ ...resource,
        readiness: { kind: 'limit_reached' as const, metric: 'inference_requests' as const, resetsAtUtc: '2026-10-26T00:00:00.000Z' },
      })) },
    })).toEqual({ kind: 'unavailable', reason: 'team_credential_usage_limit' });
    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex', accountSettings: {}, purposeCatalog,
      teamCredentialResourceCatalog: { ...catalog, resources: catalog.resources.map(resource => ({ ...resource,
        readiness: { kind: 'broker_unavailable' as const, reason: 'projection_unavailable' as const },
        recoveryAction: 'retry' as const, connectedServiceSelections: [],
      })) },
    })).toEqual({ kind: 'unavailable', reason: 'broker_unavailable' });
    const updateCatalog = { ...catalog, resources: catalog.resources.map(resource => ({ ...resource,
      readiness: { kind: 'update_required' as const }, providerModels: [], connectedServiceSelections: [],
    })) };
    expect(resolveSpawnConnectedServicesDefaultDisposition({ agentId: 'codex', accountSettings: {}, purposeCatalog,
      teamCredentialResourceCatalog: updateCatalog,
    })).toEqual({ kind: 'unavailable', reason: 'update_required' });
    expect(() => resolvePurposeTeamCredentialBindingIntents({
      teamResourceSelections: [{ purpose: { consumer: CODEX_CONSUMER, purpose: CODEX_PURPOSE },
        teamId: 'team-a', selection: agentPageTeamSelection,
        services: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }] }],
      teamCredentialResourceCatalog: updateCatalog,
    })).toThrow(expect.objectContaining({ code: 'update_required', phase: 'purpose_binding' }));
  });

  it('turns a durable Team default into the Session slot binding, and an explicit slot choice wins', () => {
    const selection = { source: 'team_resource' as const, resourceId: 'resource-a', deliveryMode: 'brokered' as const };
    const purpose = { consumer: CODEX_CONSUMER, purpose: CODEX_PURPOSE };
    const teamResourceSelections = [{
      purpose,
      teamId: 'team-a',
      selection,
      services: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }],
    }];
    const catalog = {
      serverId: 'home-a',
      accountId: 'recipient-account',
      resources: [{
        id: 'resource-a', teamId: 'team-a', displayName: resourceDisplayName('resource-a', 'Shared Codex account'), sourceOwnerDisplayName: null,
        resourceRevision: 9, readiness: { kind: 'available' as const }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
        sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
        connectedServiceSelections: [selection],
        sourcePresentation: {
          kind: 'connected_service' as const,
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
    };
    const admitted = resolvePurposeTeamCredentialBindingIntents({ teamResourceSelections, teamCredentialResourceCatalog: catalog });
    expect(admitted).toEqual([{
      v: 1,
      slot: { kind: 'connected_service_purpose', purpose },
      resourceId: 'resource-a',
      expectedResourceRevision: 9,
      deliveryMode: 'brokered',
      teamId: 'team-a',
    }]);
    let refusal: unknown;
    try {
      resolvePurposeTeamCredentialBindingIntents({ teamResourceSelections,
        teamCredentialResourceCatalog: { ...catalog, resources: catalog.resources.map(resource => ({ ...resource,
          readiness: { kind: 'limit_reached' as const, metric: 'inference_requests' as const, resetsAtUtc: '2026-10-26T00:00:00.000Z' },
        })) },
      });
    } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'team_credential_usage_limit',
      details: { v: 1, source: 'team_credential' } });
    for (const { readiness, refusal } of [
      { readiness: { kind: 'broker_unavailable' as const, reason: 'projection_unavailable' as const },
        refusal: { code: 'broker_unavailable', details: { v: 1, source: 'team_credential' } } },
      { readiness: { kind: 'broker_unavailable' as const, reason: 'response_invalid' as const },
        refusal: { code: 'broker_unavailable', details: { v: 1, source: 'team_credential' } } },
      { readiness: { kind: 'source_unavailable' as const }, refusal: { code: 'source_unavailable' } },
      { readiness: { kind: 'resource_corrupt' as const }, refusal: { code: 'resource_corrupt' } },
      { readiness: { kind: 'resource_unavailable' as const }, refusal: { code: 'resource_unavailable' } },
      { readiness: { kind: 'policy_denied' as const }, refusal: { code: 'policy_denied' } },
    ]) {
      expect(() => resolvePurposeTeamCredentialBindingIntents({ teamResourceSelections,
        teamCredentialResourceCatalog: { ...catalog, resources: catalog.resources.map(resource => ({ ...resource,
          readiness, connectedServiceSelections: [],
          recoveryAction: readiness.kind === 'source_unavailable' ? 'source_owner_action' as const : 'retry' as const,
        })) },
      })).toThrow(expect.objectContaining(refusal));
    }
    expect(() => resolvePurposeTeamCredentialBindingIntents({
      teamResourceSelections,
      teamCredentialResourceCatalog: { ...catalog, resources: [] },
    })).toThrow('connected_services_team_default_requires_current_resource');

    const explicit = [{
      v: 1 as const,
      slot: { kind: 'connected_service_purpose' as const, purpose },
      resourceId: null,
    }];
    expect(mergeSessionTeamCredentialBindingIntents({ explicit, admitted })).toEqual(explicit);
    expect(mergeSessionTeamCredentialBindingIntents({ explicit: undefined, admitted })).toEqual(admitted);
    expect(mergeSessionTeamCredentialBindingIntents({ explicit: undefined, admitted: null })).toBeUndefined();
  });

  it.each(['available', 'limit_reached'] as const)('requires the exact disclosed member for a direct Team resource default (%s)', (readinessKind) => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const disclosedMember = { service, accountId: 'source-account' } as const;
    const binding = {
      source: 'team_resource' as const,
      serverId: 'home-a',
      accountId: 'recipient-account',
      teamId: 'team-a',
      resourceId: 'resource-a',
      expectedResourceRevision: 7,
      deliveryMode: 'direct' as const,
      disclosedMember,
    };
    const accountSettings = {
      connectedServicesDefaultAuthByAgentIdV1: {
        v: 1,
        bindingsByAgentId: {
          codex: {
            v: 2,
            bindingsByServiceId: { 'happier.agent.codex/openai-codex': binding },
          },
        },
      },
    };
    const resource = {
      id: binding.resourceId,
      teamId: binding.teamId,
      displayName: resourceDisplayName(binding.resourceId, 'Shared Codex account'), sourceOwnerDisplayName: null,
      resourceRevision: binding.expectedResourceRevision,
      readiness: readinessKind === 'available' ? { kind: 'available' as const }
                : { kind: 'limit_reached' as const, metric: 'inference_requests' as const, resetsAtUtc: '2026-11-18T00:00:00Z' },
      recoveryAction: null,
      mayBroker: false,
      mayReceiveDirect: true,
      directMaterialState: 'current' as const,
      sessionUsePolicy: 'personal_allowed' as const,
      providerModels: [],
      connectedServiceSelections: [{
        source: 'team_resource' as const,
        resourceId: binding.resourceId,
        deliveryMode: 'direct' as const,
        disclosedMember,
      }],
      sourcePresentation: { kind: 'connected_service' as const, service },
    };
    const catalog = {
      serverId: binding.serverId,
      accountId: binding.accountId,
      resources: [resource],
    };

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings,
      teamCredentialResourceCatalog: catalog,
    })).toMatchObject({
      kind: 'connected',
      bindings: {
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'team_resource',
            resourceId: 'resource-a',
            deliveryMode: 'direct',
            disclosedMember,
          },
        },
      },
    });

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings,
      teamCredentialResourceCatalog: {
        ...catalog,
        resources: [{
          ...resource,
          connectedServiceSelections: [{
            ...resource.connectedServiceSelections[0]!,
            disclosedMember: { service, accountId: 'different-source-account' },
          }],
        }],
      },
    })).toEqual({
      kind: 'unavailable',
      reason: 'connected_services_team_default_requires_current_resource',
    });

    expect(resolveSpawnConnectedServicesDefaultDisposition({
      agentId: 'codex',
      accountSettings,
      teamCredentialResourceCatalog: {
        ...catalog,
        resources: [{
          ...resource,
          connectedServiceSelections: [{
            ...resource.connectedServiceSelections[0]!,
            disclosedMember: {
              accountId: disclosedMember.accountId,
              service: { ...service, localId: 'different-service' },
            },
          }],
        }],
      },
    })).toEqual({
      kind: 'unavailable',
      reason: 'connected_services_team_default_requires_current_resource',
    });
  });

});
