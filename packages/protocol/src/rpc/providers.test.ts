import { describe, expect, it } from 'vitest';

import {
  DaemonProviderModelsRequestV1Schema,
  DaemonProviderModelsResponseV1Schema,
  DaemonProviderModelLoadRequestV1Schema,
  DaemonProviderProbeRequestV1Schema,
  DaemonProviderConnectionsDescribeRequestV1Schema,
  DaemonProviderConnectionMutationRequestV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderModelProjectionRequestV1Schema,
  DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema,
  DaemonProviderBindingStatusRequestV1Schema,
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
  });

  it('accepts strict connection describe and mutation contracts without grant fingerprints or raw secrets', () => {
    expect(DaemonProviderConnectionsDescribeRequestV1Schema.parse({ machineId: 'machine-1' }))
      .toEqual({ machineId: 'machine-1' });
    const create = {
      action: 'createContribution', machineId: 'machine-1', connectionId: 'pc_1',
      contributionKey: 'acme.gateway:providers:main', displayName: null,
      savedSecretId: 'secret_1', enable: true,
    } as const;
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse(create)).toEqual(create);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({ ...create, rawSecret: 'nope' }).success).toBe(false);
    expect(DaemonProviderConnectionMutationRequestV1Schema.safeParse({
      ...create, connectionSecurityFingerprint: 'caller-controlled',
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
      contributionKey: 'happier.provider.ollama:providers:ollama',
      endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:22434/',
      displayName: null, savedSecretId: null,
    })).toMatchObject({ action: 'enableDetected', normalizedEndpointUrl: 'http://127.0.0.1:22434/' });
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'startLocal', machineId: 'machine-1', connectionId: 'pc_local',
      contributionKey: 'happier.provider.ollama:providers:ollama',
    })).toMatchObject({ action: 'startLocal' });
    expect(DaemonProviderConnectionMutationRequestV1Schema.parse({
      action: 'setEnabled', machineId: 'machine-1', connectionId: 'pc_1', enabled: false, scope: 'machine',
    })).toMatchObject({ action: 'setEnabled', enabled: false, scope: 'machine' });
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
      machineId: 'machine-1', agentTargetKey: 'backend:codex', mode: 'management',
    })).toEqual({ machineId: 'machine-1', agentTargetKey: 'backend:codex', mode: 'management' });
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
        authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
        suppressedConnectedServiceIds: ['openai-codex'],
        rows: [{
          ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_1', modelId: 'same-id' },
          descriptor: { id: 'same-id', name: 'Same' },
          sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
          compatibility: {
            result: { status: 'experimental', selectedProtocol: 'openai-responses', reasons: ['missing evidence'], confirmationScope: { kind: 'model', modelId: 'same-id' } },
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
