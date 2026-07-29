import { describe, expect, it, vi } from 'vitest';
import {
  DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderProfileMigrationPreviewResponseV1Schema,
  DaemonProviderProfileMigrationConfirmResponseV1Schema,
  DaemonProviderProfileMigrationConflictConfirmResponseV1Schema,
  RPC_METHODS,
} from '@happier-dev/protocol/rpc';
import type {
  DaemonProviderConnectionMutationRequestV1,
  DaemonProviderModelSettingsMutationRequestV1,
} from '@happier-dev/protocol/rpc';

import { registerMachineProviderRpcHandlers } from './rpcHandlers.providers';

function harness(providersEnabled = true) {
  const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
  const rpcHandlerManager = {
    registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
  } as never;
  const services = {
    probe: vi.fn(async () => ({ status: 'success' as const, models: [], requestFingerprint: 'probe-request:v1:test' as never })),
    probeDraft: vi.fn(async () => ({ status: 'success' as const, models: [], requestFingerprint: 'probe-request:v1:test' as never })),
    models: vi.fn(async () => ({
      status: 'success' as const, connectionId: 'pc_1', connectionRevision: 1,
      manualModelPolicy: 'allowed' as const, modelLoadAction: 'descriptor_absent' as const, models: [],
    })),
    loadModel: vi.fn(async () => ({ status: 'loaded' as const, source: 'requested' as const })),
    cancelModelLoad: vi.fn(async () => ({ status: 'cancelled' as const, providerMayContinue: true as const })),
    describeConnections: vi.fn(async () => DaemonProviderConnectionsDescribeResponseV1Schema.parse({
      status: 'success', connections: [], available: [], availableTruncated: false,
      discoveryCandidates: [], diagnostics: [], diagnosticsTruncated: false,
    })),
    mutateConnection: vi.fn(async (request: DaemonProviderConnectionMutationRequestV1) => DaemonProviderConnectionMutationResponseV1Schema.parse(request.action === 'delete'
      ? { status: 'success' as const, action: 'delete' as const, deletedConnectionId: request.connectionId }
      : {
          status: 'success' as const, action: request.action as 'setEnabled',
          connection: {
            connectionId: request.connectionId, contributionKey: null, displayName: 'Local', providerName: 'Local',
            role: 'named' as const, displayNameMode: 'custom' as const, sourceStatus: 'available' as const,
            grants: { accountEnabled: false, enabledMachineIds: [] },
            credential: null,
            endpoints: [],
            scope: null, authorized: false, authorizationError: null, revision: 0,
            runtime: { health: 'not_checked' as const, modelCount: null, checkedAt: null },
          },
        })),
    projectModels: vi.fn(async (request: { agentTargetKey: string }) => ({
      status: 'success' as const, agentTargetKey: request.agentTargetKey, groups: [],
    })),
    mutateModelSettings: vi.fn(async (request: DaemonProviderModelSettingsMutationRequestV1) => ({
      status: 'success' as const, action: request.action,
    })),
    resolveBindingStatus: vi.fn(async () => ({ status: 'current' as const })),
    previewProfileMigration: vi.fn(async (request: { sourceProfileId: string }) =>
      DaemonProviderProfileMigrationPreviewResponseV1Schema.parse({
        status: 'success', sourceProfileId: request.sourceProfileId,
        sourceFingerprint: 'legacy-profile-migration-source:v1:abc',
      })),
    confirmProfileMigration: vi.fn(async (request: { sourceProfileId: string; reviewedMapping: { connection: { id: string } } }) =>
      DaemonProviderProfileMigrationConfirmResponseV1Schema.parse({
        status: 'success', sourceProfileId: request.sourceProfileId,
        connectionId: request.reviewedMapping.connection.id, settingsVersion: 8,
      })),
    confirmProfileMigrationConflict: vi.fn(async (request: { sourceProfileId: string; decision: { kind: string; existingConnectionId?: string; connectionId?: string } }) =>
      DaemonProviderProfileMigrationConflictConfirmResponseV1Schema.parse({
        status: 'success', sourceProfileId: request.sourceProfileId,
        connectionId: request.decision.existingConnectionId ?? request.decision.connectionId,
        settingsVersion: 9,
      })),
  };
  registerMachineProviderRpcHandlers({
    rpcHandlerManager,
    machineId: 'machine-a',
    services,
    featureGate: { isEnabled: () => providersEnabled },
  });
  return { handlers, services };
}

describe('machine provider RPC registration', () => {
  it('fails every provider RPC closed before invoking runtime services when the root feature is disabled', async () => {
    const h = harness(false);
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROBE)!({ connectionId: 'pc_1', machineId: 'machine-a' }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODELS)!({ connectionId: 'pc_1', machineId: 'machine-a' }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD)!({
      action: 'load', connectionId: 'pc_1', machineId: 'machine-a', modelId: 'm',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE)!({ machineId: 'machine-a' }))
      .resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE)!({
      action: 'delete', connectionId: 'pc_1', machineId: 'machine-a',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)!({
      machineId: 'machine-a', agentTargetKey: 'backend:codex',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE)!({
      action: 'setVisibility', machineId: 'machine-a',
      ref: { scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'm' },
      hidden: true,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROBE)!({
      kind: 'draft', draftConnectionId: 'pc_draft_1', machineId: 'machine-a',
      template: {
        v: 1, name: 'Draft',
        endpointTemplates: [{
          id: 'openai', protocol: 'openai-chat', baseUrl: 'https://models.example/v1',
          capabilities: {
            streaming: 'unknown', toolRoundTrips: 'unknown',
            statefulResponses: 'unknown', reasoningControls: 'unknown',
          },
        }],
        catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      },
      savedSecretId: null, actionNonce: 'draft-action-0001',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    const reviewedMapping = {
      connection: {
        v: 1, id: 'pc_company',
        source: { kind: 'custom', template: {
          v: 1, name: 'Company', endpointTemplates: [{
            id: 'chat', protocol: 'openai-chat', baseUrl: 'https://company.example/v1',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          }], catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        } },
        role: 'named', displayName: 'Company', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1,
      },
      credentialMoves: [], routingEnvironmentVariableNames: ['OPENAI_BASE_URL'], manualModelIds: [],
    } as const;
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW)!({
      machineId: 'machine-a', sourceProfileId: 'company', reviewedMapping,
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM)!({
      machineId: 'machine-a', sourceProfileId: 'company', reviewedMapping,
      expectedSourceFingerprint: 'legacy-profile-migration-source:v1:abc',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM)!({
      machineId: 'machine-a', sourceProfileId: 'deepseek',
      expectedCandidateFingerprint: 'legacy-profile-migration-conflict:v1:abc',
      decision: { kind: 'keep_existing', existingConnectionId: 'pc_existing' },
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_feature_disabled' } });
    expect(h.services.probe).not.toHaveBeenCalled();
    expect(h.services.probeDraft).not.toHaveBeenCalled();
    expect(h.services.models).not.toHaveBeenCalled();
    expect(h.services.loadModel).not.toHaveBeenCalled();
    expect(h.services.describeConnections).not.toHaveBeenCalled();
    expect(h.services.mutateConnection).not.toHaveBeenCalled();
    expect(h.services.projectModels).not.toHaveBeenCalled();
    expect(h.services.mutateModelSettings).not.toHaveBeenCalled();
    expect(h.services.resolveBindingStatus).not.toHaveBeenCalled();
    expect(h.services.previewProfileMigration).not.toHaveBeenCalled();
    expect(h.services.confirmProfileMigration).not.toHaveBeenCalled();
    expect(h.services.confirmProfileMigrationConflict).not.toHaveBeenCalled();
  });

  it('delegates strict guided profile-migration preview and confirmation only on the addressed machine', async () => {
    const h = harness();
    const reviewedMapping = {
      connection: {
        v: 1, id: 'pc_company',
        source: { kind: 'custom', template: {
          v: 1, name: 'Company', endpointTemplates: [{
            id: 'chat', protocol: 'openai-chat', baseUrl: 'https://company.example/v1',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          }], catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        } },
        deployment: { kind: 'external' },
        role: 'named', displayName: 'Company', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1,
      },
      credentialMoves: [], routingEnvironmentVariableNames: ['OPENAI_BASE_URL'], manualModelIds: [],
    } as const;
    const preview = { machineId: 'machine-a', sourceProfileId: 'company', reviewedMapping } as const;
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW)!(preview))
      .resolves.toMatchObject({ status: 'success', sourceFingerprint: 'legacy-profile-migration-source:v1:abc' });
    expect(h.services.previewProfileMigration).toHaveBeenCalledWith(preview);

    const confirm = {
      ...preview, expectedSourceFingerprint: 'legacy-profile-migration-source:v1:abc',
    } as const;
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFIRM)!(confirm))
      .resolves.toEqual({ status: 'success', sourceProfileId: 'company', connectionId: 'pc_company', settingsVersion: 8 });
    expect(h.services.confirmProfileMigration).toHaveBeenCalledWith(confirm);

    const conflictConfirm = {
      machineId: 'machine-a', sourceProfileId: 'deepseek',
      expectedCandidateFingerprint: 'legacy-profile-migration-conflict:v1:abc',
      decision: { kind: 'keep_existing' as const, existingConnectionId: 'pc_existing' },
    };
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_CONFLICT_CONFIRM)!(conflictConfirm))
      .resolves.toEqual({ status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 9 });
    expect(h.services.confirmProfileMigrationConflict).toHaveBeenCalledWith(conflictConfirm);

    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW)!({
      ...preview, machineId: 'machine-b',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_not_enabled_on_machine' } });
    expect(h.services.previewProfileMigration).toHaveBeenCalledTimes(1);
  });

  it('delegates strict exact-target projection and intent-only model settings mutations', async () => {
    const h = harness();
    const projection = { machineId: 'machine-a', agentTargetKey: 'backend:codex' } as const;
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)!(projection))
      .resolves.toEqual({ status: 'success', agentTargetKey: 'backend:codex', groups: [] });
    expect(h.services.projectModels).toHaveBeenCalledWith(projection);

    const mutation = {
      action: 'setVisibility' as const, machineId: 'machine-a',
      ref: { scope: 'agent' as const, agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'm' },
      hidden: true,
    };
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE)!(mutation))
      .resolves.toEqual({ status: 'success', action: 'setVisibility' });
    expect(h.services.mutateModelSettings).toHaveBeenCalledWith(mutation);
  });

  it('registers strict connection describe/mutate handlers and validates redacted responses', async () => {
    const h = harness();
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE)!({ machineId: 'machine-a' }))
      .resolves.toEqual({
        status: 'success', connections: [], available: [], availableTruncated: false,
        discoveryCandidates: [], discoveryCandidatesTruncated: false, localInstallations: [],
        diagnostics: [], diagnosticsTruncated: false,
      });
    const request = { action: 'delete' as const, connectionId: 'pc_1', machineId: 'machine-a' };
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE)!(request))
      .resolves.toEqual({ status: 'success', action: 'delete', deletedConnectionId: 'pc_1' });
    expect(h.services.describeConnections).toHaveBeenCalledWith({ machineId: 'machine-a' });
    expect(h.services.mutateConnection).toHaveBeenCalledWith(request);

    h.services.describeConnections.mockResolvedValueOnce({
      status: 'success', connections: [], available: [], rawSecret: 'must-not-cross',
    } as never);
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE)!({ machineId: 'machine-a' }))
      .rejects.toThrow();
  });

  it('delegates one strict explicit draft Test action without exposing a daemon authorization id', async () => {
    const h = harness();
    const request = {
      kind: 'draft',
      draftConnectionId: 'pc_draft_1',
      machineId: 'machine-a',
      template: {
        v: 1,
        name: 'Draft',
        endpointTemplates: [{
          id: 'openai', protocol: 'openai-chat', baseUrl: 'https://models.example/v1',
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
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROBE)!(request))
      .resolves.toMatchObject({ status: 'success' });
    expect(h.services.probeDraft).toHaveBeenCalledWith(request);
    expect(h.services.probe).not.toHaveBeenCalled();
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROBE)!({
      ...request, probeAuthorizationId: 'must-stay-daemon-held',
    })).rejects.toThrow();
  });

  it('registers strict probe/models/load handlers and delegates identity only', async () => {
    const h = harness();
    await h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROBE)!({ connectionId: 'pc_1', machineId: 'machine-a' });
    await h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODELS)!({ connectionId: 'pc_1', machineId: 'machine-a' });
    await h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD)!({ action: 'load', connectionId: 'pc_1', machineId: 'machine-a', modelId: 'm' });
    await h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD)!({ action: 'cancel', connectionId: 'pc_1', machineId: 'machine-a', modelId: 'm' });
    expect(h.services.probe).toHaveBeenCalledWith({ connectionId: 'pc_1', machineId: 'machine-a' });
    expect(h.services.models).toHaveBeenCalledWith({ connectionId: 'pc_1', machineId: 'machine-a' });
    expect(h.services.loadModel).toHaveBeenCalledWith({ connectionId: 'pc_1', machineId: 'machine-a', modelId: 'm' });
    expect(h.services.cancelModelLoad).toHaveBeenCalledWith({ connectionId: 'pc_1', machineId: 'machine-a', modelId: 'm' });
  });

  it('refuses another machine before invoking services', async () => {
    const h = harness();
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_PROBE)!({
      connectionId: 'pc_1', machineId: 'machine-b',
    })).resolves.toMatchObject({ status: 'error', error: { code: 'provider_not_enabled_on_machine' } });
    expect(h.services.probe).not.toHaveBeenCalled();
  });

  it('rejects unknown fields before service invocation', async () => {
    const h = harness();
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD)!({
      action: 'load', connectionId: 'pc_1', machineId: 'machine-a', modelId: 'm', credential: 'secret',
    })).rejects.toThrow();
    expect(h.services.loadModel).not.toHaveBeenCalled();
  });

  it('rejects non-contract service output instead of forwarding secret-bearing fields', async () => {
    const h = harness();
    h.services.models.mockResolvedValueOnce([{ id: 'm', source: 'manual', stale: false, loadState: 'unknown', credential: 'secret' }] as never);
    await expect(h.handlers.get(RPC_METHODS.DAEMON_PROVIDERS_MODELS)!({
      connectionId: 'pc_1', machineId: 'machine-a',
    })).rejects.toThrow();
  });
});
