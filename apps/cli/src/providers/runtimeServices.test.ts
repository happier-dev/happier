import { describe, expect, it, vi } from 'vitest';
import {
  createProviderErrorV1,
  ProviderConnectionIdSchema,
  ProviderProbeRequestFingerprintV1Schema,
} from '@happier-dev/protocol';
import type { MachineProviderRpcServices } from '@/api/machine/rpcHandlers.providers';

import {
  createCurrentRuntimeProviderOperationsSource,
  createRuntimeProviderOperationsProducer,
  type RuntimeProviderOperationsProducer,
} from './runtimeServices';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function currentBinding(controller = new AbortController()) {
  return {
    controller,
    binding: {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    },
  };
}

const providersEnabledFeatureGate = Object.freeze({
  isEnabled: (_featureId: 'providers') => true,
});

function createMachineServices(): MachineProviderRpcServices {
  return {
    probe: vi.fn(async () => ({
      status: 'success' as const,
      models: [],
      requestFingerprint: ProviderProbeRequestFingerprintV1Schema.parse('probe-request:v1:test'),
    })),
    probeDraft: vi.fn(async () => ({
      status: 'success' as const,
      models: [],
      requestFingerprint: ProviderProbeRequestFingerprintV1Schema.parse('probe-request:v1:test'),
    })),
    models: vi.fn(async () => ({
      status: 'success' as const,
      connectionId: 'pc_1',
      connectionRevision: 1,
      manualModelPolicy: 'allowed' as const,
      modelLoadAction: 'descriptor_absent' as const,
      models: [],
    })),
    loadModel: vi.fn(async () => ({ status: 'loaded' as const, source: 'requested' as const })),
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
      status: 'error' as const,
      error: createProviderErrorV1('provider_connection_not_found', {
        connectionId: 'pc_1',
        machineId: 'machine-a',
      }),
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
    resolveBindingStatus: vi.fn(async () => ({ status: 'current' as const })),
    previewProfileMigration: vi.fn(async (request) => ({
      status: 'success' as const,
      sourceProfileId: request.sourceProfileId,
      sourceFingerprint: 'legacy-profile-migration-source:v1:test',
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

describe('runtime Provider operation production boundary', () => {
  it('keeps an invocation bound before machine bootstrap connected to the current producer', async () => {
    const machineServices = createMachineServices();
    let currentProducer: RuntimeProviderOperationsProducer | null = null;
    const source = createCurrentRuntimeProviderOperationsSource(
      () => currentProducer,
    );
    const { binding } = currentBinding();
    const operations = source.bind(binding);

    await expect(operations.connections.describe({}))
      .rejects.toMatchObject({ code: 'plugin_service_unavailable' });

    currentProducer = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    });

    await expect(operations.connections.describe({}))
      .resolves.toMatchObject({ status: 'success' });
    expect(machineServices.describeConnections).toHaveBeenCalledWith({
      machineId: 'machine-a',
    });
  });

  it('binds the exact eleven machine-scoped operations over the same owner used by RPC', async () => {
    const machineServices = createMachineServices();
    const producer = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    });
    const { binding } = currentBinding();
    const operations = producer.bind(binding);
    const connectionId = ProviderConnectionIdSchema.parse('pc_1');

    expect(producer.machineServices).toBe(machineServices);
    expect(producer.bind(binding)).not.toBe(operations);
    expect(Object.keys(operations.connections)).toEqual(['describe', 'mutate', 'bindingStatus']);
    expect(Object.keys(operations.catalog)).toEqual([
      'probe',
      'listModels',
      'setModelLoad',
      'projectModels',
      'mutateModelSettings',
    ]);
    expect(Object.keys(operations.migrations)).toEqual(['preview', 'confirm', 'confirmConflict']);

    await expect(operations.connections.describe({})).resolves.toMatchObject({ status: 'success' });
    expect(machineServices.describeConnections).toHaveBeenCalledWith({ machineId: 'machine-a' });

    await expect(operations.connections.describe({ machineId: 'machine-b' } as never))
      .resolves.toMatchObject({ status: 'success' });
    expect(machineServices.describeConnections).toHaveBeenLastCalledWith({ machineId: 'machine-a' });

    await expect(operations.catalog.probe({ connectionId })).resolves.toMatchObject({ status: 'success' });
    expect(machineServices.probe).toHaveBeenCalledWith(
      { connectionId, machineId: 'machine-a' },
      expect.objectContaining({ signal: binding.signal, isCurrent: expect.any(Function) }),
    );

    vi.mocked(machineServices.mutateConnection).mockResolvedValueOnce({
      status: 'success',
      action: 'startLocal',
      contributionKey: 'acme.gateway/gateway',
      phase: 'running',
    });
    await expect(operations.connections.mutate({
      action: 'startLocal',
      contributionKey: 'acme.gateway/gateway',
      connectionId: 'pc_spoofed',
    } as never)).resolves.toMatchObject({ status: 'success', action: 'startLocal' });
    expect(machineServices.mutateConnection).toHaveBeenCalledWith({
      action: 'startLocal',
      contributionKey: 'acme.gateway/gateway',
      machineId: 'machine-a',
    });

    await expect(operations.catalog.setModelLoad({
      action: 'cancel',
      connectionId,
      modelId: 'model-a',
    })).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
    expect(machineServices.cancelModelLoad).toHaveBeenCalledWith({
      action: 'cancel',
      connectionId,
      machineId: 'machine-a',
      modelId: 'model-a',
      signal: expect.any(AbortSignal),
    });

    await expect(operations.connections.describe({ leakedAuthority: 'machine-b' } as never))
      .rejects.toThrow();
    expect(machineServices.describeConnections).toHaveBeenCalledTimes(2);

    vi.mocked(machineServices.describeConnections).mockResolvedValueOnce({
      status: 'success',
      connections: [],
      available: [],
      availableTruncated: false,
      discoveryCandidates: [],
      discoveryCandidatesTruncated: false,
      localInstallations: [],
      diagnostics: [],
      diagnosticsTruncated: false,
      rawSecret: 'must-not-cross',
    } as never);
    await expect(operations.connections.describe({})).rejects.toThrow();
  });

  it('fences stale invocation authority and pre-admission caller cancellation without dispatching', async () => {
    const machineServices = createMachineServices();
    const producer = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    });
    const invocation = currentBinding();
    invocation.controller.abort();

    await expect(producer.bind(invocation.binding).connections.describe({}))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });
    expect(machineServices.describeConnections).not.toHaveBeenCalled();

    const staleWithoutAbort = {
      signal: new AbortController().signal,
      isCurrent: () => false,
    };
    await expect(producer.bind(staleWithoutAbort).catalog.listModels({
      connectionId: ProviderConnectionIdSchema.parse('pc_1'),
    })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    expect(machineServices.models).not.toHaveBeenCalled();

    const caller = new AbortController();
    caller.abort();
    await expect(producer.bind(currentBinding().binding).connections.mutate({
      action: 'delete',
      connectionId: ProviderConnectionIdSchema.parse('pc_1'),
    }, { signal: caller.signal })).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    expect(machineServices.mutateConnection).not.toHaveBeenCalled();
  });

  it('lets a cancelled read caller stop waiting while the admitted owner work settles', async () => {
    const machineServices = createMachineServices();
    const ownerResult = deferred<Awaited<ReturnType<MachineProviderRpcServices['describeConnections']>>>();
    vi.mocked(machineServices.describeConnections).mockImplementationOnce(async () => await ownerResult.promise);
    const operations = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    }).bind(currentBinding().binding);
    const caller = new AbortController();

    const pending = operations.connections.describe({}, { signal: caller.signal });
    await vi.waitFor(() => expect(machineServices.describeConnections).toHaveBeenCalledOnce());
    caller.abort();
    const callerOutcome = await Promise.race([
      pending.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({
          status: 'rejected' as const,
          code: (error as Readonly<{ code?: string }>).code,
        }),
      ),
      new Promise<Readonly<{ status: 'timeout' }>>((resolve) => {
        setTimeout(() => resolve({ status: 'timeout' }), 50);
      }),
    ]);
    ownerResult.resolve({
      status: 'success',
      connections: [],
      available: [],
      availableTruncated: false,
      discoveryCandidates: [],
      discoveryCandidatesTruncated: false,
      localInstallations: [],
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(callerOutcome).toEqual({ status: 'rejected', code: 'plugin_operation_aborted' });
    await expect(ownerResult.promise).resolves.toMatchObject({ status: 'success' });
  });

  it('settles an admitted mutation after cancellation and maps a lost result to the canonical unknown outcome', async () => {
    const machineServices = createMachineServices();
    const ownerResult = deferred<Awaited<ReturnType<MachineProviderRpcServices['mutateConnection']>>>();
    vi.mocked(machineServices.mutateConnection).mockImplementationOnce(async () => await ownerResult.promise);
    const invocation = currentBinding();
    const operations = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    }).bind(invocation.binding);
    const caller = new AbortController();
    const request = {
      action: 'delete' as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_1'),
    };

    const pending = operations.connections.mutate(request, { signal: caller.signal });
    await vi.waitFor(() => expect(machineServices.mutateConnection).toHaveBeenCalledOnce());
    caller.abort();
    invocation.controller.abort();
    ownerResult.resolve({ status: 'success', action: 'delete', deletedConnectionId: request.connectionId });
    await expect(pending).resolves.toEqual({
      status: 'success',
      action: 'delete',
      deletedConnectionId: request.connectionId,
    });

    const second = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    }).bind(currentBinding().binding);
    vi.mocked(machineServices.mutateConnection).mockRejectedValueOnce(
      new Error('acknowledgement lost after dispatch'),
    );
    await expect(second.connections.mutate(request)).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'provider_rpc_mutation_outcome_unknown',
        connectionId: request.connectionId,
        machineId: 'machine-a',
      },
    });

    vi.mocked(machineServices.mutateConnection).mockResolvedValueOnce({
      status: 'success',
      action: 'delete',
    } as never);
    await expect(second.connections.mutate(request)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'provider_rpc_mutation_outcome_unknown' },
    });
  });

  it('composes model-load cancellation into the canonical owner signal and preserves providerMayContinue', async () => {
    const machineServices = createMachineServices();
    let ownerSignal: AbortSignal | undefined;
    vi.mocked(machineServices.loadModel).mockImplementationOnce(async (request) => {
      ownerSignal = request.signal;
      if (request.signal?.aborted) {
        return { status: 'cancelled', providerMayContinue: true };
      }
      return await Promise.race([
        new Promise<Readonly<{ status: 'cancelled'; providerMayContinue: true }>>((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve({ status: 'cancelled', providerMayContinue: true });
          }, { once: true });
        }),
        new Promise<Readonly<{ status: 'loaded'; source: 'requested' }>>((resolve) => {
          setTimeout(() => resolve({ status: 'loaded', source: 'requested' }), 100);
        }),
      ]);
    });
    const invocation = currentBinding();
    const operations = createRuntimeProviderOperationsProducer({
      machineId: 'machine-a',
      machineServices,
      featureGate: providersEnabledFeatureGate,
    }).bind(invocation.binding);
    const caller = new AbortController();

    const pending = operations.catalog.setModelLoad({
      action: 'load',
      connectionId: ProviderConnectionIdSchema.parse('pc_1'),
      modelId: 'model-a',
    }, { signal: caller.signal });
    await vi.waitFor(() => expect(machineServices.loadModel).toHaveBeenCalledOnce());
    expect(ownerSignal).toBeDefined();
    expect(ownerSignal).not.toBe(caller.signal);
    caller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled', providerMayContinue: true });
    expect(ownerSignal?.aborted).toBe(true);

    const preCancelled = new AbortController();
    preCancelled.abort();
    await expect(operations.catalog.setModelLoad({
      action: 'load',
      connectionId: ProviderConnectionIdSchema.parse('pc_1'),
      modelId: 'model-b',
    }, { signal: preCancelled.signal })).resolves.toEqual({
      status: 'cancelled',
      providerMayContinue: true,
    });
    expect(machineServices.loadModel).toHaveBeenCalledOnce();
  });
});
