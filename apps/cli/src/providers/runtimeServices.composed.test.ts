import { describe, expect, it, vi } from 'vitest';

import {
  ProviderConnectionIdSchema,
  ProviderProbeRequestFingerprintV1Schema,
} from '@happier-dev/protocol';
import type { MachineProviderRpcServices } from '@/api/machine/rpcHandlers.providers';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createRunnerDaemonPluginServicesHost } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  PUBLIC_PROVIDER_OPERATION_IDS,
  runPublicProviderOperations,
  type PublicProviderOperationRequests,
} from '@/plugins/testkit/fixtures/public-provider-services/consumer';

import { createRuntimeProviderOperationsProducer } from './runtimeServices';

function reviewedMapping() {
  return {
    connection: {
      v: 1 as const,
      id: ProviderConnectionIdSchema.parse('pc_company'),
      source: {
        kind: 'custom' as const,
        template: {
          v: 1 as const,
          name: 'Company gateway',
          endpointTemplates: [{
            id: 'chat',
            protocol: 'openai-chat' as const,
            baseUrl: 'https://gateway.example/v1',
            capabilities: {
              streaming: 'unknown' as const,
              toolRoundTrips: 'unknown' as const,
              statefulResponses: 'unknown' as const,
              reasoningControls: 'unknown' as const,
            },
          }],
          catalog: {
            source: 'manual' as const,
            manualModelPolicy: 'allowed' as const,
          },
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

function operationRequests(): PublicProviderOperationRequests {
  const mapping = reviewedMapping();
  const connectionId = ProviderConnectionIdSchema.parse('pc_1');
  return {
    describe: {},
    mutate: {
      action: 'startLocal',
      contributionKey: 'acme.gateway/gateway',
    },
    bindingStatus: {
      agentTargetKey: 'backend:codex',
      selection: {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: connectionId,
          modelId: 'model-a',
        },
      },
      launchBinding: {
        v: 1,
        connectionId,
        contributionKey: null,
        connectionRevision: 1,
        protocol: 'openai-responses',
        materialization: 'engineConfig',
        compatibilityFingerprint: 'compatibility:v1:test',
        bindingSecurityFingerprint: 'binding-security:v1:test',
        displaySnapshot: {
          providerName: 'Gateway',
          connectionName: 'Work',
          connectionRole: 'named',
          connectionDisplayNameMode: 'custom',
        },
      },
    },
    probe: { connectionId },
    listModels: { connectionId },
    setModelLoad: {
      action: 'load',
      connectionId,
      modelId: 'model-a',
    },
    projectModels: { agentTargetKey: 'backend:codex' },
    mutateModelSettings: {
      action: 'resetVisibility',
      scope: { kind: 'connection', connectionId },
    },
    previewMigration: {
      sourceProfileId: 'company',
      reviewedMapping: mapping,
    },
    confirmMigration: {
      sourceProfileId: 'company',
      reviewedMapping: mapping,
      expectedSourceFingerprint:
        'legacy-profile-migration-source:v1:test',
    },
    confirmMigrationConflict: {
      sourceProfileId: 'company',
      expectedCandidateFingerprint:
        'legacy-profile-migration-conflict:v1:test',
      decision: {
        kind: 'keep_existing',
        existingConnectionId:
          ProviderConnectionIdSchema.parse('pc_existing'),
      },
    },
  };
}

function createMachineServices(): MachineProviderRpcServices {
  return {
    probe: vi.fn(async () => ({
      status: 'success' as const,
      models: [],
      requestFingerprint:
        ProviderProbeRequestFingerprintV1Schema.parse(
          'probe-request:v1:composed',
        ),
    })),
    probeDraft: vi.fn(async () => ({
      status: 'success' as const,
      models: [],
      requestFingerprint:
        ProviderProbeRequestFingerprintV1Schema.parse(
          'probe-request:v1:composed-draft',
        ),
    })),
    models: vi.fn(async () => ({
      status: 'success' as const,
      connectionId: 'pc_1',
      connectionRevision: 1,
      manualModelPolicy: 'allowed' as const,
      modelLoadAction: 'descriptor_absent' as const,
      models: [],
    })),
    loadModel: vi.fn(async () => ({
      status: 'loaded' as const,
      source: 'requested' as const,
    })),
    cancelModelLoad: vi.fn(async () => ({
      status: 'cancelled' as const,
      providerMayContinue: true as const,
    })),
    describeConnections: vi.fn(async () => ({
      status: 'success' as const,
      connections: [],
      available: [],
      availableTruncated: false,
      discoveryCandidates: [],
      discoveryCandidatesTruncated: false,
      localInstallations: [],
      diagnostics: [],
      diagnosticsTruncated: false,
    })),
    mutateConnection: vi.fn(async () => ({
      status: 'success' as const,
      action: 'startLocal' as const,
      contributionKey: 'acme.gateway/gateway',
      phase: 'running' as const,
    })),
    projectModels: vi.fn(async (request) => ({
      status: 'success' as const,
      agentTargetKey: request.agentTargetKey,
      groups: [],
    })),
    mutateModelSettings: vi.fn(async (request) => ({
      status: 'success' as const,
      action: request.action,
    })),
    resolveBindingStatus: vi.fn(async () => ({
      status: 'current' as const,
    })),
    previewProfileMigration: vi.fn(async (request) => ({
      status: 'success' as const,
      sourceProfileId: request.sourceProfileId,
      sourceFingerprint:
        'legacy-profile-migration-source:v1:test',
    })),
    confirmProfileMigration: vi.fn(async (request) => ({
      status: 'success' as const,
      sourceProfileId: request.sourceProfileId,
      connectionId: request.reviewedMapping.connection.id,
      settingsVersion: 2,
    })),
    confirmProfileMigrationConflict: vi.fn(async (request) => ({
      status: 'success' as const,
      sourceProfileId: request.sourceProfileId,
      connectionId: request.decision.kind === 'keep_existing'
        ? request.decision.existingConnectionId
        : request.decision.connectionId,
      settingsVersion: 3,
    })),
  };
}

const runnerBinding = createAgentSessionRunnerFactoryBinding({
  v: 1,
  pluginId: 'fixture.plugin',
  pluginVersion: '1.0.0',
  agentId: 'fixture.agent',
  localAgentId: 'agent',
  immutableGenerationId: 'generation-1',
  locator: {
    module: './agent.js',
    export: 'createRuntime',
    runtimeApiVersion: 1,
  },
  normalizedModulePath: 'agent.js',
  loadMode: 'immutable-js',
});

const runner = Object.freeze({
  pid: 123,
  processStartTimeMs: 1,
  processCommandHash: '4'.repeat(64),
  snapshotIdentity: 'snapshot-1',
});

describe('public Provider operations composed routing', () => {
  it('fails plugin-originated migration operations closed on the current root Providers decision', async () => {
    const machineServices = createMachineServices();
    let providersEnabled = false;
    const producer = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: {
        isEnabled: () => providersEnabled,
      },
    });
    const controller = new AbortController();
    const owners = createProductionPluginInvocationServiceOwners({
      loggerSink: { write: () => {} },
      providers: producer,
    });
    const ordinaryServices = owners.createServices({
      plugin: { id: 'fixture.plugin', version: '1.0.0' },
      contribution: {
        id: 'run',
        qualifiedId: 'fixture.plugin/actions/run',
      },
      generation: 'generation-1',
      correlationId: 'ordinary-provider-feature-gate',
      surface: 'cli',
      signal: controller.signal,
      isGenerationCurrent: () => true,
    }, owners.createOrdinaryServiceBinding(
      'generation-1',
      'ordinary-provider-feature-gate',
    ));
    const requests = operationRequests();

    await expect(ordinaryServices.providers.migrations.preview(
      requests.previewMigration,
    )).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_feature_disabled' },
    });
    await expect(ordinaryServices.providers.migrations.confirm(
      requests.confirmMigration,
    )).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_feature_disabled' },
    });
    await expect(ordinaryServices.providers.migrations.confirmConflict(
      requests.confirmMigrationConflict,
    )).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_feature_disabled' },
    });
    expect(machineServices.previewProfileMigration).not.toHaveBeenCalled();
    expect(machineServices.confirmProfileMigration).not.toHaveBeenCalled();
    expect(machineServices.confirmProfileMigrationConflict).not.toHaveBeenCalled();

    providersEnabled = true;
    await expect(ordinaryServices.providers.migrations.preview(
      requests.previewMigration,
    )).resolves.toMatchObject({ status: 'success' });
    expect(machineServices.previewProfileMigration).toHaveBeenCalledOnce();
  });

  it('routes one public-only workflow through the real producer in ordinary and retained-runner realms', async () => {
    const machineServices = createMachineServices();
    const producer = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: { isEnabled: () => true },
    });
    const controller = new AbortController();
    const owners = createProductionPluginInvocationServiceOwners({
      loggerSink: { write: () => {} },
      providers: producer,
    });
    const ordinaryServices = owners.createServices({
      plugin: { id: 'fixture.plugin', version: '1.0.0' },
      contribution: {
        id: 'run',
        qualifiedId: 'fixture.plugin/actions/run',
      },
      generation: 'generation-1',
      correlationId: 'ordinary-provider-workflow',
      surface: 'cli',
      signal: controller.signal,
      isGenerationCurrent: () => true,
    }, owners.createOrdinaryServiceBinding(
      'generation-1',
      'ordinary-provider-workflow',
    ));
    const requests = operationRequests();

    const ordinary = await runPublicProviderOperations(
      { services: ordinaryServices },
      requests,
    );

    const host = createRunnerDaemonPluginServicesHost({
      async createInvocation() {
        return {
          services: ordinaryServices,
          resourceDescriptors: {},
          subscriptionCapabilities: {
            settingsWatch: false,
            eventSubscriptions: [],
            resourceWatches: [],
            notificationPreferencesWatch: false,
          },
          dispose() {},
          authorizeOperation: () => true,
          executeCurrentGlobalAction: async () => null,
          currentGlobalMcp: ordinaryServices.mcp,
          currentGlobalExternalSessions:
            ordinaryServices.sessions.external,
        };
      },
    });
    const unavailable = createUnavailablePluginServices();
    const retainedServices = await prepareRunnerDaemonPluginServices({
      invocationId: 'retained-provider-workflow',
      signal: controller.signal,
      dispatch: async (operation, options) => {
        const hosted = await host.dispatch({
          sessionId: 'session-1',
          runner,
          retainedAgent: runnerBinding,
          operation,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        return decodeRunnerDaemonPluginServiceWireValueV1(hosted.value);
      },
      local: {
        availability: unavailable.availability,
        logger: unavailable.logger,
        sessions: unavailable.sessions,
        managedServices: unavailable.managedServices,
        exec: unavailable.exec,
        interactions: unavailable.interactions,
        targetedContributions: unavailable.targetedContributions,
        composerContent: unavailable.composerContent,
      },
    });

    const retained = await runPublicProviderOperations(
      { services: retainedServices },
      requests,
    );

    expect(ordinary.map(({ operation }) => operation)).toEqual(
      PUBLIC_PROVIDER_OPERATION_IDS,
    );
    expect(retained.map(({ operation }) => operation)).toEqual(
      PUBLIC_PROVIDER_OPERATION_IDS,
    );

    const routeMatrix = [
      ['connections.describe', machineServices.describeConnections],
      ['connections.mutate', machineServices.mutateConnection],
      ['connections.bindingStatus', machineServices.resolveBindingStatus],
      ['catalog.probe', machineServices.probe],
      ['catalog.listModels', machineServices.models],
      ['catalog.setModelLoad', machineServices.loadModel],
      ['catalog.projectModels', machineServices.projectModels],
      ['catalog.mutateModelSettings', machineServices.mutateModelSettings],
      ['migrations.preview', machineServices.previewProfileMigration],
      ['migrations.confirm', machineServices.confirmProfileMigration],
      [
        'migrations.confirmConflict',
        machineServices.confirmProfileMigrationConflict,
      ],
    ] as const;
    expect(routeMatrix.map(([operation]) => operation)).toEqual(
      PUBLIC_PROVIDER_OPERATION_IDS,
    );
    // `catalog.probe` is the one route that also receives the waiter lifetime, so the
    // producer can keep a long-poll probe alive exactly as long as the binding generation
    // and the caller's cancellation allow. Every other route stays strictly single-argument.
    const waiterLifetime = expect.objectContaining({
      signal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    });
    for (const [operation, route] of routeMatrix) {
      const trailingArguments = operation === 'catalog.probe' ? [waiterLifetime] : [];
      expect(route).toHaveBeenCalledTimes(2);
      expect(route).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ machineId: 'machine-a' }),
        ...trailingArguments,
      );
      expect(route).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ machineId: 'machine-a' }),
        ...trailingArguments,
      );
    }
    expect(machineServices.probeDraft).not.toHaveBeenCalled();
    expect(machineServices.cancelModelLoad).not.toHaveBeenCalled();
    await host.dispose();
  });
});
