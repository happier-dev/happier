import { describe, expect, it } from 'vitest';

import { createProviderErrorV1 } from '../providers/errors.js';

import {
  DaemonProviderModelsRequestV1Schema,
  DaemonProviderModelsResponseV1Schema,
  DaemonProviderModelLoadRequestV1Schema,
  DaemonProviderProbeRequestV1Schema,
  DaemonProviderProbeResponseV1Schema,
  DaemonProviderConnectionsDescribeRequestV1Schema,
  DaemonProviderConnectionMutationRequestV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderAgentCompatibilitySummaryV1Schema,
  DaemonProviderModelProjectionRequestV1Schema,
  DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema,
  DaemonProviderBindingStatusRequestV1Schema,
  DaemonProviderBindingStatusResponseV1Schema,
  DaemonProviderProfileMigrationPreviewRequestV1Schema,
  DaemonProviderProfileMigrationPreviewResponseV1Schema,
  DaemonProviderProfileMigrationConfirmRequestV1Schema,
  DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmRequestV1Schema,
  DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
  RPC_METHODS,
} from './index.js';

function reviewedLegacyProfileMapping() {
  return {
    connection: {
      v: 1 as const,
      id: 'pc_company',
      source: {
        kind: 'custom' as const,
        template: {
          v: 1 as const,
          name: 'Company gateway',
          endpointTemplates: [{
            id: 'chat', protocol: 'openai-chat' as const, baseUrl: 'https://gateway.example/v1',
            capabilities: {
              streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const,
              statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const,
            },
          }],
          catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
        },
      },
      role: 'named' as const,
      displayName: 'Company gateway',
      displayNameMode: 'custom' as const,
      deployment: { kind: 'external' as const },
      revision: 0,
      createdAt: 10,
      updatedAt: 10,
    },
    credentialMoves: [],
    routingEnvironmentVariableNames: ['OPENAI_BASE_URL'],
    manualModelIds: ['company-model'],
  };
}

describe('provider machine RPC contracts', () => {
  it('uses closed compatibility reason codes and status-correct reason cardinality', () => {
    expect(DaemonProviderAgentCompatibilitySummaryV1Schema.safeParse({
      agentTargetKey: 'backend:codex', agentName: 'Codex',
      status: 'experimental', reasons: ['compatibility_evidence_missing'],
    }).success).toBe(true);
    expect(DaemonProviderAgentCompatibilitySummaryV1Schema.safeParse({
      agentTargetKey: 'backend:codex', agentName: 'Codex',
      status: 'experimental', reasons: ['future_untyped_reason'],
    }).success).toBe(false);
    expect(DaemonProviderAgentCompatibilitySummaryV1Schema.safeParse({
      agentTargetKey: 'backend:codex', agentName: 'Codex',
      status: 'verified', reasons: ['compatibility_evidence_missing'],
    }).success).toBe(false);
  });

  it('uses stable daemon method ids', () => {
    expect(RPC_METHODS.DAEMON_PROVIDERS_PROBE).toBe('daemon.providers.probe');
    expect(RPC_METHODS.DAEMON_PROVIDERS_MODELS).toBe('daemon.providers.models');
    expect(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD).toBe('daemon.providers.model.load');
    expect(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE).toBe('daemon.providers.connections.describe');
    expect(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE).toBe('daemon.providers.connection.mutate');
    expect(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION).toBe('daemon.providers.model.projection');
    expect(RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE).toBe('daemon.providers.model.settings.mutate');
    expect(RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS).toBe('daemon.providers.binding.status');
    expect(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW).toBe('daemon.providers.profileMigration.preview');
    expect(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM).toBe('daemon.providers.profileMigration.confirm');
    expect(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM)
      .toBe('daemon.providers.profileMigration.conflict.confirm');
  });

  it('returns probed model ids when the provider does not supply display names', () => {
    expect(DaemonProviderProbeResponseV1Schema.parse({
      status: 'success',
      models: [{ id: 'provider-model-without-display-name' }],
      requestFingerprint: `probe-request:v1:${'a'.repeat(43)}`,
    })).toEqual({
      status: 'success',
      models: [{ id: 'provider-model-without-display-name' }],
      requestFingerprint: `probe-request:v1:${'a'.repeat(43)}`,
    });
  });

  it('rejects duplicate model ids in a successful probe response', () => {
    expect(DaemonProviderProbeResponseV1Schema.safeParse({
      status: 'success',
      models: [{ id: 'duplicate-model' }, { id: 'duplicate-model', name: 'Duplicate' }],
      requestFingerprint: `probe-request:v1:${'a'.repeat(43)}`,
    }).success).toBe(false);
  });

  it('rejects successful probe responses above the canonical catalog limit', () => {
    expect(DaemonProviderProbeResponseV1Schema.safeParse({
      status: 'success',
      models: Array.from({ length: 5_001 }, (_, index) => ({ id: `provider-model-${index}` })),
      requestFingerprint: `probe-request:v1:${'a'.repeat(43)}`,
    }).success).toBe(false);
  });

  it('describes a closed built-in authoring review without granting the browser endpoint authority', () => {
    const selectedCandidateId = 'discovery-candidate:v1:selected';
    const request = {
      machineId: 'machine-1',
      authoringPreview: {
        connectionId: 'pc_preview',
        contributionKey: 'acme.gateway/main',
        displayName: null,
        selectedCandidateId,
        endpointOverrides: [{
          endpointTemplateId: 'chat',
          baseUrl: 'https://remote.gateway.example/v1',
        }],
      },
    } as const;
    expect(DaemonProviderConnectionsDescribeRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      status: 'success',
      connections: [], available: [], discoveryCandidates: [], localInstallations: [],
      diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
      discoveryCandidatesTruncated: false,
      authoringPreview: {
        status: 'resolved', connectionId: 'pc_preview', contributionKey: 'acme.gateway/main', created: true,
        candidateId: selectedCandidateId,
        scope: 'machine',
        machineId: 'machine-1',
        endpoints: [{
          endpointTemplateId: 'chat', protocol: 'openai-chat',
          normalizedUrl: 'http://127.0.0.1:1234/v1', locality: 'loopback', scope: 'machine',
        }],
        credential: { slotId: 'apiKey', label: 'api_key', required: false },
        fingerprint: 'authoring-review:v1:reviewed',
        revision: 1,
      },
    }).success).toBe(true);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
      diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
      discoveryCandidatesTruncated: false,
      authoringPreview: {
        status: 'selection_required', connectionId: 'pc_preview',
        contributionKey: 'acme.gateway/main', created: true,
        credential: null,
        candidates: [{
          candidateId: selectedCandidateId,
          scope: 'machine', machineId: 'machine-1',
          endpoints: [{
            endpointTemplateId: 'chat', protocol: 'openai-chat',
            normalizedUrl: 'http://127.0.0.1:1234/v1', locality: 'loopback', scope: 'machine',
          }],
        }, {
          candidateId: 'discovery-candidate:v1:alternate',
          scope: 'machine', machineId: 'machine-1',
          endpoints: [{
            endpointTemplateId: 'chat', protocol: 'openai-chat',
            normalizedUrl: 'http://127.0.0.1:1235/v1', locality: 'loopback', scope: 'machine',
          }],
        }],
      },
    }).success).toBe(true);
  });

  it('defines a strict redacted conflict-resolution contract', () => {
    const request = {
      machineId: 'machine-1',
      sourceProfileId: 'deepseek',
      expectedCandidateFingerprint: 'legacy-profile-migration-conflict:v1:abc',
      decision: { kind: 'keep_existing', existingConnectionId: 'pc_existing' },
    } as const;
    expect(DaemonProviderProfileMigrationConflictConfirmRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonProviderProfileMigrationConflictConfirmRequestV1Schema.safeParse({
      ...request,
      savedSecretId: 'must-never-cross-rpc',
    }).success).toBe(false);
    expect(DaemonProviderProfileMigrationConflictConfirmResponseV1Schema.parse({
      status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 9,
    })).toMatchObject({ status: 'success', connectionId: 'pc_existing' });
  });

  it('defines strict redacted guided profile-migration preview and confirmation contracts', () => {
    const reviewedMapping = reviewedLegacyProfileMapping();
    const preview = {
      machineId: 'machine-1', sourceProfileId: 'company', reviewedMapping,
    } as const;
    expect(DaemonProviderProfileMigrationPreviewRequestV1Schema.parse(preview)).toEqual(preview);
    expect(DaemonProviderProfileMigrationPreviewRequestV1Schema.safeParse({
      ...preview, rawSettings: { secretBindingsByProfileId: { company: 'secret' } },
    }).success).toBe(false);
    expect(DaemonProviderProfileMigrationPreviewResponseV1Schema.parse({
      status: 'success', sourceProfileId: 'company',
      sourceFingerprint: 'legacy-profile-migration-source:v1:abc',
    })).toMatchObject({ status: 'success', sourceProfileId: 'company' });

    const confirm = {
      ...preview,
      expectedSourceFingerprint: 'legacy-profile-migration-source:v1:abc',
    } as const;
    expect(DaemonProviderProfileMigrationConfirmRequestV1Schema.parse(confirm)).toEqual(confirm);
    expect(DaemonProviderProfileMigrationConfirmRequestV1Schema.safeParse({
      ...confirm, migratedAt: 123,
    }).success).toBe(false);
    expect(DaemonProviderProfileMigrationConfirmResponseV1Schema.parse({
      status: 'success', sourceProfileId: 'company', connectionId: 'pc_company', settingsVersion: 8,
    })).toMatchObject({ status: 'success', connectionId: 'pc_company', settingsVersion: 8 });
  });

  it('binds session status checks to one exact launch connection and target', () => {
    const value = {
      machineId: 'machine-1', agentTargetKey: 'backend:codex',
      selection: {
        v: 1, updatedAt: 1,
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'm' },
      },
      launchBinding: {
        v: 1, connectionId: 'pc_1', contributionKey: null, connectionRevision: 1,
        protocol: 'openai-responses', materialization: 'engineConfig',
        compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
        displaySnapshot: {
          providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom',
        },
      },
    } as const;
    expect(DaemonProviderBindingStatusRequestV1Schema.parse(value)).toEqual(value);
    expect(DaemonProviderBindingStatusRequestV1Schema.safeParse({
      ...value, agentTargetKey: 'backend:claude',
    }).success).toBe(false);
    expect(DaemonProviderBindingStatusResponseV1Schema.parse({
      status: 'changed',
      nextBindingSecurityFingerprint: 'binding-security:v1:b',
    })).toEqual({
      status: 'changed',
      nextBindingSecurityFingerprint: 'binding-security:v1:b',
    });
    expect(DaemonProviderBindingStatusResponseV1Schema.safeParse({ status: 'changed' }).success).toBe(false);
  });

  it('accepts strict connection describe and mutation contracts without grant fingerprints or raw secrets', () => {
    expect(DaemonProviderConnectionsDescribeRequestV1Schema.parse({ machineId: 'machine-1' }))
      .toEqual({ machineId: 'machine-1' });
    const create = {
      action: 'createContribution', machineId: 'machine-1', connectionId: 'pc_1',
      contributionKey: 'acme.gateway/main', displayName: null,
      savedSecretId: 'secret_1', enable: true,
      authoringReview: {
        candidateId: null,
        fingerprint: 'authoring-review:v1:reviewed',
        revision: 0,
        endpointOverrides: [{
          endpointTemplateId: 'chat',
          baseUrl: 'https://remote.gateway.example/v1',
        }],
      },
    } as const;
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse(create)).toEqual(create);
    const { authoringReview: _authoringReview, ...unreviewedCreate } = create;
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse(unreviewedCreate).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({ ...create, rawSecret: 'nope' }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...create, connectionSecurityFingerprint: 'caller-controlled',
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...create,
      authoringReview: {
        ...create.authoringReview,
        endpointOverrides: [
          ...create.authoringReview.endpointOverrides,
          ...create.authoringReview.endpointOverrides,
        ],
      },
    }).success).toBe(false);
    const custom = {
      action: 'createCustom' as const, machineId: 'machine-1', connectionId: 'pc_custom',
      template: {
        v: 1 as const, name: 'Custom',
        endpointTemplates: [{
          id: 'anthropic', protocol: 'anthropic' as const, baseUrl: 'https://gateway.example/anthropic',
          capabilities: { streaming: 'unknown' as const, toolRoundTrips: 'unknown' as const, statefulResponses: 'unknown' as const, reasoningControls: 'unknown' as const },
        }],
        catalog: { source: 'manual' as const, manualModelPolicy: 'allowed' as const },
      },
      savedSecretId: null, enable: false,
      manualModels: [{ id: 'anthropic/model-a', name: 'Model A' }],
    };
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse(custom)).toEqual(custom);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...custom, manualModels: [{ id: 'same' }, { id: 'same' }],
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...custom,
      template: { ...custom.template, catalog: { source: 'probe', manualModelPolicy: 'catalog-only', probes: [{ endpointTemplateId: 'anthropic', path: '/models', parser: 'openai-models' }] } },
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'enableDetected', machineId: 'machine-1', connectionId: 'pc_local',
      candidateId: 'discovery-candidate:v1:current',
      displayName: null, savedSecretId: null,
    })).toMatchObject({ action: 'enableDetected', candidateId: 'discovery-candidate:v1:current' });
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      action: 'enableDetected', machineId: 'machine-1', connectionId: 'pc_local',
      contributionKey: 'happier.provider.ollama/ollama',
      endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:22434/',
      displayName: null, savedSecretId: null,
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'startLocal', machineId: 'machine-1', connectionId: 'pc_local',
      contributionKey: 'happier.provider.ollama/ollama',
    })).toMatchObject({ action: 'startLocal' });
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'startLocal', machineId: 'machine-1',
      contributionKey: 'happier.provider.ollama/ollama',
    })).toEqual({
      action: 'startLocal', machineId: 'machine-1',
      contributionKey: 'happier.provider.ollama/ollama',
    });
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'setEnabled', machineId: 'machine-1', connectionId: 'pc_1', enabled: false, scope: 'machine',
    })).toMatchObject({ action: 'setEnabled', enabled: false, scope: 'machine' });
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'setEnabled', machineId: 'machine-1', connectionId: 'pc_1', enabled: false, scope: 'connection',
    })).toMatchObject({ action: 'setEnabled', enabled: false, scope: 'connection' });
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      action: 'setEnabled', machineId: 'machine-1', connectionId: 'pc_1', enabled: true, scope: 'connection',
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'bindSecret', machineId: 'machine-1', connectionId: 'pc_1',
      credentialSlotId: 'apiKey', savedSecretId: null, scope: 'account',
    })).toMatchObject({ action: 'bindSecret', savedSecretId: null });
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      action: 'bindSecret', machineId: 'machine-1', connectionId: 'pc_1',
      credentialSlotId: 'otherKey', savedSecretId: null, scope: 'account',
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'setEndpointOverride', machineId: 'machine-1', connectionId: 'pc_1', expectedRevision: 0,
      scope: 'machine', endpointTemplateId: 'openai', baseUrl: null,
    })).toMatchObject({ action: 'setEndpointOverride', baseUrl: null });
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      action: 'update', machineId: 'machine-1', connectionId: 'pc_1', expectedRevision: 0,
      endpointOverrides: [], endpointScope: 'account',
    }).success).toBe(false);

    const managedUpdate = {
      action: 'update' as const,
      machineId: 'machine-1',
      connectionId: 'pc_1',
      expectedRevision: 0,
      deployment: {
        kind: 'managedLocal' as const,
        purposeBindingDefaults: {
          upstream: {
            kind: 'group' as const,
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            groupId: 'team',
          },
        },
      },
    };
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse(managedUpdate))
      .toEqual(managedUpdate);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...managedUpdate,
      deployment: {
        kind: 'managedLocal',
        purposeBindingDefaults: {},
      },
    }).success).toBe(true);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...managedUpdate,
      deployment: {
        ...managedUpdate.deployment,
        purposeBindingDefaults: {
          upstream: {
            ...managedUpdate.deployment.purposeBindingDefaults.upstream,
            profileId: 'active-member-must-not-persist',
            generation: 4,
          },
        },
      },
    }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...managedUpdate,
      deployment: {
        kind: 'external',
        purposeBindingDefaults: managedUpdate.deployment.purposeBindingDefaults,
      },
    }).success).toBe(false);
  });

  it('describes every machine grant allowed by provider settings without truncation', () => {
    const enabledMachineIds = Array.from({ length: 257 }, (_, index) => `machine-${index}`);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      status: 'success',
      connections: [{
        connectionId: 'pc_1', contributionKey: null, displayName: 'Local', providerName: 'Local', icon: null,
        role: 'named', displayNameMode: 'custom', sourceStatus: 'available',
        probeCapability: 'none', manualModelPolicy: 'allowed',
        compatibility: [{
          agentTargetKey: 'backend:codex', agentName: 'Codex', status: 'experimental',
          reasons: ['compatibility_evidence_missing'],
        }],
        grants: { accountEnabled: false, enabledMachineIds },
        credential: null,
        endpoints: [{
          endpointTemplateId: 'openai', protocol: 'openai-chat',
          baseUrl: 'http://127.0.0.1:1234/v1', effectiveSource: 'template',
        }],
        scope: null, authorized: false, authorizationError: null, revision: 0,
        runtime: { health: 'not_checked', modelCount: null, checkedAt: null },
      }],
      available: [],
      discoveryCandidates: [],
      localInstallations: [],
      availableTruncated: false,
      diagnostics: [],
      diagnosticsTruncated: false,
    }).success).toBe(true);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.parse({
      status: 'success',
      connections: [], available: [], discoveryCandidates: [], localInstallations: [],
      availableTruncated: false, diagnostics: [], diagnosticsTruncated: false,
    })).toMatchObject({ status: 'success' });
  });

  it('describes only public managed connection effects without exposing launch-local authority', () => {
    const publicEffects = {
      implementationIdentity: {
        pluginId: 'happier.provider.gateway',
        localId: 'gateway',
      },
      protocols: ['openai-responses', 'openai-chat'],
      connectedAccountPurposes: [{
        purpose: 'upstream',
        service: {
          pluginId: 'happier.connected-account.openai',
          localId: 'openai',
        },
        required: true,
        materializationKinds: ['httpHeaders'],
        target: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.openai',
              localId: 'openai',
            },
            accountId: 'work',
          },
        },
      }],
    } as const;
    const retiredProcess = {
      localServiceId: 'gateway',
      manager: 'happier',
      lifetime: 'session',
      network: 'loopback',
      restart: 'never',
    } as const;
    const retiredDependency = {
      kind: 'packaged-runtime-binary',
      directorySegments: ['cliproxyapi', 'unpacked'],
      executableBaseName: 'cliproxyapi',
    } as const;
    const managedConnection = {
      connectionId: 'pc_managed',
      contributionKey: 'happier.provider.gateway/gateway',
      provenance: 'first_party',
      displayName: 'Managed Gateway',
      providerName: 'Managed Gateway',
      icon: null,
      role: 'named',
      displayNameMode: 'automatic',
      sourceStatus: 'available',
      probeCapability: 'catalog',
      manualModelPolicy: 'catalog-only',
      compatibility: [],
      grants: { accountEnabled: false, enabledMachineIds: ['machine-1'] },
      credential: null,
      deployment: {
        kind: 'managedLocal',
        targetMachineId: 'machine-1',
        effects: publicEffects,
      },
      endpoints: [],
      scope: 'machine',
      authorized: true,
      authorizationError: null,
      revision: 1,
      runtime: { health: 'not_checked', modelCount: null, checkedAt: null },
    } as const;
    const response = {
      status: 'success' as const,
      connections: [managedConnection],
      available: [],
      discoveryCandidates: [],
      localInstallations: [],
      availableTruncated: false,
      diagnostics: [],
      diagnosticsTruncated: false,
    };

    expect(DaemonProviderConnectionsDescribeResponseV1Schema.parse(response))
      .toMatchObject({ connections: [{ deployment: managedConnection.deployment, endpoints: [] }] });
    for (const retiredEffects of [
      { ...publicEffects, process: retiredProcess },
      { ...publicEffects, dependency: retiredDependency },
      {
        ...publicEffects,
        process: retiredProcess,
        dependency: retiredDependency,
      },
    ]) {
      expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
        ...response,
        connections: [{
          ...managedConnection,
          deployment: {
            ...managedConnection.deployment,
            effects: retiredEffects,
          },
        }],
      }).success).toBe(false);
    }
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{
        ...managedConnection,
        sourceStatus: 'unavailable',
        authorized: false,
        deployment: {
          kind: 'managedLocal',
          targetMachineId: 'machine-1',
          effects: null,
        },
      }],
    }).success).toBe(true);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{
        ...managedConnection,
        deployment: {
          ...managedConnection.deployment,
          effects: { ...managedConnection.deployment.effects, assignedPort: 31_337 },
        },
      }],
    }).success).toBe(false);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{
        ...managedConnection,
        deployment: {
          ...managedConnection.deployment,
          effects: { ...managedConnection.deployment.effects, bearer: 'must-not-cross-rpc' },
        },
      }],
    }).success).toBe(false);
    for (const provenance of ['first_party', 'external', 'custom'] as const) {
      expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
        ...response,
        connections: [{ ...managedConnection, provenance }],
      }).success).toBe(true);
    }
  });

  it('preserves localized purpose presentation and the producer-authored binding policy for managed authoring', () => {
    const managedLocalOption = {
      targetMachineId: 'machine-1',
      connectedAccountPurposeBindingPolicy: { minimumBound: 1 as const },
      connectedAccountPurposes: [{
        purpose: 'upstream',
        service: {
          pluginId: 'happier.connected-account.openai',
          localId: 'openai',
        },
        title: {
          key: 'connectedAccounts.upstream.title',
          fallback: 'Use upstream OpenAI account',
        },
        required: true,
        materializationKinds: ['httpHeaders'],
      }],
    };
    const connection = {
      connectionId: 'pc_1',
      contributionKey: 'happier.provider.gateway/gateway',
      provenance: 'first_party',
      displayName: 'Gateway',
      providerName: 'Gateway',
      icon: null,
      role: 'default',
      displayNameMode: 'automatic',
      sourceStatus: 'available',
      probeCapability: 'catalog',
      manualModelPolicy: 'catalog-only',
      compatibility: [],
      grants: { accountEnabled: false, enabledMachineIds: [] },
      credential: null,
      deployment: { kind: 'external' },
      managedLocalOption,
      endpoints: [{
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'https://gateway.example/v1',
        effectiveSource: 'template',
      }],
      scope: null,
      authorized: false,
      authorizationError: null,
      revision: 0,
      runtime: {
        health: 'not_checked',
        modelCount: null,
        checkedAt: null,
      },
    } as const;
    const response = {
      status: 'success' as const,
      connections: [connection],
      available: [],
      discoveryCandidates: [],
      localInstallations: [],
      availableTruncated: false,
      diagnostics: [],
      diagnosticsTruncated: false,
    };

    expect(DaemonProviderConnectionsDescribeResponseV1Schema.parse(response))
      .toMatchObject({ connections: [{ managedLocalOption }] });
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{
        ...connection,
        managedLocalOption: {
          ...managedLocalOption,
          connectedAccountPurposes: [],
        },
      }],
    }).success).toBe(true);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse(response).success).toBe(true);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{ ...connection, provenance: 'external' }],
    }).success).toBe(true);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{
        ...connection,
        managedLocalOption: {
          ...managedLocalOption,
          connectedAccountPurposes: [{
            ...managedLocalOption.connectedAccountPurposes[0],
            target: { kind: 'group', groupId: 'must-not-be-projected' },
          }],
        },
      }],
    }).success).toBe(false);
  });

  it('exposes only an opaque current probe-observation identity on connection views', () => {
    const connection = {
      connectionId: 'pc_1', contributionKey: null, displayName: 'Gateway', providerName: 'Gateway', icon: null,
      websiteUrl: 'https://gateway.example',
      role: 'named', displayNameMode: 'custom', sourceStatus: 'available',
      probeCapability: 'catalog', manualModelPolicy: 'allowed', compatibility: [],
      grants: { accountEnabled: true, enabledMachineIds: [] },
      credential: {
        required: true,
        accountBound: true,
        boundMachineIds: [],
        keyUrl: 'https://gateway.example/keys',
      },
      endpoints: [{
        endpointTemplateId: 'openai', protocol: 'openai-chat',
        baseUrl: 'https://gateway.example/v1', effectiveSource: 'template',
      }],
      scope: 'account', authorized: true, authorizationError: null, revision: 2,
      probeObservationIdentity: 'probe-observation:v1:opaque-current-facts',
      runtime: { health: 'available', modelCount: 1, checkedAt: 10 },
    } as const;
    const response = {
      status: 'success' as const,
      connections: [connection], available: [], discoveryCandidates: [], localInstallations: [],
      availableTruncated: false, diagnostics: [], diagnosticsTruncated: false,
    };

    expect(DaemonProviderConnectionsDescribeResponseV1Schema.parse(response))
      .toMatchObject({
        connections: [{
          websiteUrl: 'https://gateway.example',
          credential: { keyUrl: 'https://gateway.example/keys' },
          probeObservationIdentity: connection.probeObservationIdentity,
        }],
      });
    const { probeObservationIdentity: _legacyMissingIdentity, ...legacyConnection } = connection;
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.parse({
      ...response,
      connections: [legacyConnection],
    }).connections[0]?.probeObservationIdentity).toBeNull();
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{ ...connection, probeObservationIdentity: 'secret-one' }],
    }).success).toBe(false);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{ ...connection, websiteUrl: 'http://gateway.example' }],
    }).success).toBe(false);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      connections: [{
        ...connection,
        credential: { ...connection.credential, keyUrl: 'javascript:alert(1)' },
      }],
    }).success).toBe(false);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      available: [{
        contributionKey: 'acme.gateway/main', name: 'Acme', kind: 'cloud',
        provenance: 'first_party', icon: null, websiteUrl: 'http://gateway.example', credential: null,
      }],
    }).success).toBe(false);
    expect(DaemonProviderConnectionsDescribeResponseV1Schema.safeParse({
      ...response,
      available: [{
        contributionKey: 'acme.gateway/main', name: 'Acme', kind: 'cloud',
        provenance: 'first_party', icon: null,
        credential: { required: true, keyUrl: 'file:///tmp/key' },
      }],
    }).success).toBe(false);
  });

  it('defines a strict redacted exact-target model projection contract', () => {
    const request = {
      machineId: 'machine-1',
      agentTargetKey: 'backend:codex',
      currentSelection: {
        agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'same-id',
      },
    } as const;
    expect(DaemonProviderModelProjectionRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonProviderModelProjectionRequestV1Schema.parse({
      machineId: 'machine-1', agentTargetKey: 'backend:codex', mode: 'management', forceRefresh: true,
    })).toEqual({
      machineId: 'machine-1', agentTargetKey: 'backend:codex', mode: 'management', forceRefresh: true,
    });
    expect(DaemonProviderModelProjectionRequestV1Schema.safeParse({
      ...request, agentTargetKey: 'codex',
    }).success).toBe(false);

    const response = {
      status: 'success',
      agentTargetKey: 'backend:codex',
      groups: [{
        connectionId: 'pc_1', providerName: 'Gateway', connectionName: 'Work',
        connectionRole: 'named', connectionDisplayNameMode: 'custom',
        connectionRevision: 1,
        modelLoadAction: 'descriptor_absent',
        modelLoadPreflightPolicy: null,
        authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: ['openai-codex'],
        rows: [{
          ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'same-id' },
          descriptor: { id: 'same-id', name: 'Same' },
          sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
          compatibility: {
            result: { status: 'experimental', selectedProtocol: 'openai-responses', reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId: 'same-id' } },
            compatibilityFingerprint: 'compatibility:v1:abc', confirmed: false,
          },
          endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown',
          visibility: 'visible',
        }],
      }],
    } as const;
    expect(DaemonProviderModelProjectionResponseV1Schema.parse(response)).toEqual(response);
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse({
      ...response,
      groups: [{
        ...response.groups[0],
        rows: [{ ...response.groups[0].rows[0], visibility: 'hidden_all_agents' }],
      }],
    }).success).toBe(true);
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse({
      ...response, groups: [{ ...response.groups[0], endpointUrl: 'https://private.example' }],
    }).success).toBe(false);
  });

  it('allows one stale-current recovery row beyond the active model limit and rejects a second', () => {
    const baseRow = {
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'model-0' },
      descriptor: { id: 'model-0', name: 'Model 0' },
      sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
      compatibility: {
        result: { status: 'experimental', selectedProtocol: 'openai-responses', reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId: 'model-0' } },
        compatibilityFingerprint: 'compatibility:v1:abc', confirmed: false,
      },
      endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
    } as const;
    const activeRows = Array.from({ length: 5_000 }, (_, index) => ({
      ...baseRow,
      ref: { ...baseRow.ref, modelId: `model-${index}` },
      descriptor: { ...baseRow.descriptor, id: `model-${index}`, name: `Model ${index}` },
    }));
    const staleCurrent = {
      ...baseRow,
      ref: { ...baseRow.ref, modelId: 'stale-current' },
      descriptor: { ...baseRow.descriptor, id: 'stale-current', name: 'Stale current' },
      catalog: { stale: true },
      visibility: 'visible' as const,
    };
    const group = {
      connectionId: 'pc_1', providerName: 'Gateway', connectionName: 'Work',
      connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const,
      connectionRevision: 1, modelLoadAction: 'descriptor_absent' as const,
      modelLoadPreflightPolicy: null, authorization: { authorized: true as const },
      manualModelPolicy: 'allowed' as const, supportsFreeformModelIds: true,
      suppressedConnectedServiceIds: [], rows: [...activeRows, staleCurrent],
    };
    const response = { status: 'success' as const, agentTargetKey: 'backend:codex', groups: [group] };
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse(response).success).toBe(true);
    const secondStale = {
      ...staleCurrent,
      ref: { ...staleCurrent.ref, modelId: 'stale-second' },
      descriptor: { ...staleCurrent.descriptor, id: 'stale-second' },
    };
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse({
      ...response,
      groups: [{ ...group, rows: [...activeRows.slice(0, 4_999), staleCurrent, secondStale] }],
    }).success).toBe(false);
  });

  it('closes current Provider selection recovery over typed missing-source, deleted-connection, and missing-model states', () => {
    const ref = {
      agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'same-id',
    } as const;
    const cases = [
      {
        kind: 'contribution_unavailable',
        error: createProviderErrorV1('provider_contribution_unavailable', { connectionId: 'pc_1', machineId: 'machine-1' }),
      },
      {
        kind: 'connection_deleted',
        error: createProviderErrorV1('provider_connection_not_found', { connectionId: 'pc_1', machineId: 'machine-1' }),
      },
      {
        kind: 'model_not_found',
        error: createProviderErrorV1('provider_model_not_found', { connectionId: 'pc_1', machineId: 'machine-1' }),
      },
    ] as const;
    for (const recovery of cases) {
      expect(DaemonProviderModelProjectionResponseV1Schema.parse({
        status: 'success',
        agentTargetKey: 'backend:codex',
        groups: [],
        currentSelectionRecovery: {
          ...recovery,
          ref,
          displaySnapshot: {
            providerName: 'Gateway', connectionName: 'Work', modelName: 'Same',
          },
        },
      })).toMatchObject({ currentSelectionRecovery: recovery });
    }
  });

  it('carries typed cold-refresh failures beside successful groups and stays strict about them', () => {
    const failure = {
      connectionId: 'pc_1',
      error: createProviderErrorV1('provider_endpoint_unavailable', { connectionId: 'pc_1', machineId: 'machine-1' }),
    } as const;
    const successWithFailures = {
      status: 'success',
      agentTargetKey: 'backend:codex',
      groups: [],
      refreshFailures: [failure],
    } as const;
    // A reader without the field (or a writer without failures) round-trips unchanged.
    expect(DaemonProviderModelProjectionResponseV1Schema.parse({
      status: 'success', agentTargetKey: 'backend:codex', groups: [],
    })).toEqual({ status: 'success', agentTargetKey: 'backend:codex', groups: [] });
    expect(DaemonProviderModelProjectionResponseV1Schema.parse(successWithFailures))
      .toEqual(successWithFailures);
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse({
      ...successWithFailures,
      refreshFailures: [{ ...failure, error: { ...failure.error, retryable: false } }],
    }).success).toBe(false);
    expect(DaemonProviderModelProjectionResponseV1Schema.safeParse({
      ...successWithFailures,
      refreshFailures: [{ connectionId: 'pc_1' }],
    }).success).toBe(false);
  });

  it('accepts only intent-level bounded model settings mutations', () => {
    const values = [
      { action: 'manualAdd', machineId: 'machine-1', connectionId: 'pc_1', expectedConnectionRevision: 1, models: [{ id: 'org/model', name: 'Model' }, { id: 'org/other' }] },
      { action: 'manualRemove', machineId: 'machine-1', connectionId: 'pc_1', expectedConnectionRevision: 1, modelId: 'org/model' },
      { action: 'setVisibility', machineId: 'machine-1', ref: { scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'haiku' }, hidden: true },
      { action: 'resetVisibility', machineId: 'machine-1', scope: { kind: 'connection', connectionId: 'pc_1' } },
      { action: 'bulkVisibility', machineId: 'machine-1', changes: [
        { ref: { scope: 'allAgents', providerConnectionId: 'pc_1', modelId: 'm' }, hidden: false },
        { ref: { scope: 'allAgents', providerConnectionId: 'pc_1', modelId: 'other' }, hidden: true },
      ] },
      { action: 'confirmExperimental', machineId: 'machine-1', connectionId: 'pc_1', expectedConnectionRevision: 1, agentTargetKey: 'backend:codex', modelId: 'm', compatibilityFingerprint: 'compatibility:v1:abc' },
    ] as const;
    for (const value of values) {
      expect(DaemonProviderModelSettingsMutationRequestV1Schema.parse(value)).toEqual(value);
    }
    expect(DaemonProviderModelSettingsMutationRequestV1Schema.safeParse({
      ...values[5], rawSecret: 'nope',
    }).success).toBe(false);
    expect(DaemonProviderModelSettingsMutationRequestV1Schema.safeParse({
      action: 'manualAdd', machineId: 'machine-1', connectionId: 'pc_1', expectedConnectionRevision: 1,
      models: [{ id: 'same' }, { id: 'same' }],
    }).success).toBe(false);
    expect(DaemonProviderModelSettingsMutationRequestV1Schema.safeParse({
      action: 'bulkVisibility', machineId: 'machine-1', changes: [
        { ref: { scope: 'allAgents', providerConnectionId: 'pc_1', modelId: 'same' }, hidden: false },
        { ref: { scope: 'allAgents', providerConnectionId: 'pc_1', modelId: 'same' }, hidden: true },
      ],
    }).success).toBe(false);
  });

  it('accepts identity-only bounded requests', () => {
    expect(DaemonProviderProbeRequestV1Schema.parse({ connectionId: 'pc_1', machineId: 'machine-1' }))
      .toEqual({ connectionId: 'pc_1', machineId: 'machine-1' });
    expect(DaemonProviderModelsRequestV1Schema.parse({ connectionId: 'pc_1', machineId: 'machine-1' }))
      .toEqual({ connectionId: 'pc_1', machineId: 'machine-1' });
    expect(DaemonProviderModelLoadRequestV1Schema.parse({
      action: 'load', connectionId: 'pc_1', machineId: 'machine-1', modelId: 'model-a',
    })).toEqual({ action: 'load', connectionId: 'pc_1', machineId: 'machine-1', modelId: 'model-a' });
    expect(DaemonProviderModelLoadRequestV1Schema.parse({
      action: 'cancel', connectionId: 'pc_1', machineId: 'machine-1', modelId: 'model-a',
    })).toEqual({ action: 'cancel', connectionId: 'pc_1', machineId: 'machine-1', modelId: 'model-a' });
    expect(DaemonProviderModelsResponseV1Schema.parse({
      status: 'success', connectionId: 'pc_1', connectionRevision: 4,
      manualModelPolicy: 'allowed',
      modelLoadAction: 'descriptor_absent',
      models: [{ id: 'model-a', source: 'manual', stale: false, loadState: 'unknown', visibility: 'visible' }],
    })).toMatchObject({
      status: 'success', connectionRevision: 4, manualModelPolicy: 'allowed',
      modelLoadAction: 'descriptor_absent',
    });
  });

  it('accepts a strict unsaved draft test action without exposing daemon authorization ids or raw keys', () => {
    const request = {
      kind: 'draft',
      draftConnectionId: 'pc_draft_1',
      machineId: 'machine-a',
      template: {
        v: 1,
        name: 'Draft gateway',
        endpointTemplates: [{
          id: 'openai',
          protocol: 'openai-chat',
          baseUrl: 'https://gateway.example/v1',
          capabilities: {
            streaming: 'unknown', toolRoundTrips: 'unknown',
            statefulResponses: 'unknown', reasoningControls: 'unknown',
          },
        }],
        catalog: {
          source: 'probe', manualModelPolicy: 'allowed',
          probes: [{ endpointTemplateId: 'openai', path: '/models', parser: 'openai-models' }],
        },
      },
      savedSecretId: null,
      actionNonce: 'draft-action-0001',
    } as const;

    expect(DaemonProviderProbeRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonProviderProbeRequestV1Schema.safeParse({
      ...request,
      probeAuthorizationId: 'daemon-held-id',
    }).success).toBe(false);
    expect(DaemonProviderProbeRequestV1Schema.safeParse({ ...request, rawKey: 'secret' }).success).toBe(false);
  });

  it('rejects endpoint, credential, descriptor, and unknown fields', () => {
    for (const value of [
      { connectionId: 'pc_1', machineId: 'machine-1', endpoint: 'http://localhost:1234' },
      { connectionId: 'pc_1', machineId: 'machine-1', credential: 'secret' },
      { action: 'load', connectionId: 'pc_1', machineId: 'machine-1', modelId: 'm', descriptor: {} },
    ]) {
      const schema = 'action' in value ? DaemonProviderModelLoadRequestV1Schema : DaemonProviderProbeRequestV1Schema;
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});
