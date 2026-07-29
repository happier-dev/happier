import { describe, expect, it, vi } from 'vitest';

import type {
  QualifiedConnectedAccountPurposeBindingV1,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountRequestAuthSubject,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import type {
  ExecProcessHandleV1,
  ExecRuntimeServiceV1,
} from '@/plugins/runtime/exec/privateContract';
import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';
import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from '@happier-dev/plugins-cliproxyapi';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ManagedProviderEndpointDeclarationV1 } from '@/providers/managed/types';
import type { ProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';
import type {
  TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';

import { createProviderLaunchResourceScope } from './resourceScope';
import {
  prepareManagedProviderEndpointLaunch,
  type ManagedProviderEndpointReadiness,
} from './managedEndpointLaunch';

const purpose: QualifiedConnectedAccountPurposeV1 = {
  consumer: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  purpose: 'openai-upstream',
};
const purposeBinding: QualifiedConnectedAccountPurposeBindingV1 = {
  purpose,
  target: {
    kind: 'account',
    account: {
      service: {
        pluginId: 'happier.connected-account.openai',
        localId: 'codex',
      },
      accountId: 'work',
    },
  },
};
const requestAuthUse = {
  purpose,
  materialization: {
    kind: 'httpHeaders' as const,
    origin: 'https://chatgpt.com',
    headerNames: ['authorization', 'chatgpt-account-id'],
  },
};
const localService = {
  id: 'managed-provider',
  launch: {
    kind: 'packaged-runtime-binary',
    directorySegments: ['tools', 'unpacked'],
    executableBaseName: 'happier-cliproxyapi-managed',
    privateConfigPathFlag: '--config',
  },
  launchMode: {
    kind: 'assignAndInject',
    portPolicy: { kind: 'allocated' },
    environment: { inject: ['PORT', 'HOST'] },
  },
  hostPolicy: { kind: 'loopback', host: '127.0.0.1' },
  name: { strategy: 'fixed', name: 'Managed Provider' },
  healthCheck: { kind: 'http', path: '/healthz' },
  restart: { kind: 'never' },
  cleanup: { staleAfterMs: 60_000 },
} as const satisfies ManagedProviderEndpointDeclarationV1['localService'];

function contribution(
  provenance: 'first_party' | 'external' = 'first_party',
): ResolvedProviderContribution {
  const base = {
    pluginId: 'happier.provider.cliproxyapi',
    identity: {
      pluginId: 'happier.provider.cliproxyapi',
      localId: 'cliproxyapi',
    },
    definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
  } as const;
  if (provenance === 'external') {
    return {
      ...base,
      provenance: 'external',
      source: { kind: 'path' },
    };
  }
  return {
    ...base,
    provenance: 'first_party',
    source: { kind: 'bundled' },
    managed: {
      managedEndpoint: {
        localService,
        protocols: ['openai-chat', 'openai-responses', 'anthropic'],
      },
      connectedAccounts: [{
        purpose: purpose.purpose,
        service: purposeBinding.target.kind === 'account'
          ? purposeBinding.target.account.service
          : purposeBinding.target.service,
        required: true,
      }],
      requestAuthUses: [{
        purpose: purpose.purpose,
        materialization: requestAuthUse.materialization,
      }],
    },
  };
}

type ManagedAuthorizationImplementation = Extract<
  ProviderSpawnAuthorizationAttempt,
  { deployment: { kind: 'managedLocal' } }
>['authorization']['deployment']['implementation'];

function managedDeployment(
  overrides: Partial<ManagedAuthorizationImplementation> = {},
): ManagedAuthorizationImplementation {
  const resolved = contribution();
  if (!resolved.managed) throw new Error('expected managed contribution');
  return {
    kind: 'managedLocal',
    implementationIdentity: resolved.identity,
    facet: resolved.managed,
    purposeBindings: {
      v: 1,
      bindings: [purposeBinding],
    },
    ...overrides,
  };
}

function ownedRun(overrides: Partial<TrustedManagedLocalServiceOwnedRun> = {}):
TrustedManagedLocalServiceOwnedRun {
  return {
    serviceKey: 'managed-provider:session-a',
    runId: 7,
    snapshot: {
      id: localService.id,
      phase: 'running',
      port: 45_123,
      diagnostics: [],
    },
    process: {
      pid: 301,
      startedAt: 1_000,
      processStartTimeMs: 1_717_171_717_301,
      processCommandHash: 'a'.repeat(64),
    },
    host: '127.0.0.1',
    port: 45_123,
    ...overrides,
  };
}

function processHandle(): ExecProcessHandleV1 {
  return {
    pid: 301,
    exit: new Promise(() => {}),
    writeStdin: vi.fn(async () => undefined),
    kill: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

function harness(input: Readonly<{
  resolvedContribution?: ResolvedProviderContribution;
  startResult?: TrustedManagedLocalServiceOwnedRun | null;
  managedLocalServicesEnabled?: boolean;
  authorizationDeployment?: ReturnType<typeof managedDeployment>;
  stopResultStatus?: 'stopped' | 'stale' | 'unavailable';
  requestAuthSubject?: ConnectedAccountRequestAuthSubject;
  requestAuthHttpPort?: number;
}> = {}) {
  const events: string[] = [];
  const resolvedContribution = input.resolvedContribution ?? contribution();
  let currentRun = input.startResult === undefined ? ownedRun() : input.startResult;
  let authorizationCurrent = true;
  const readinessSignal: { value: AbortSignal | null } = { value: null };
  const launchAbortController = new AbortController();
  const outputTee = {
    onChunk: vi.fn(),
  };
  let activatedSubject: Parameters<
    Parameters<typeof prepareManagedProviderEndpointLaunch>[1]['activateRequestAuth']
  >[0]['subject'] | null = null;
  let activatedHttpPort: number | null = null;
  const ownedCleanups: Array<Readonly<{
    cleanup: () => void | Promise<void>;
    phase: 'beforeProcessStop' | 'afterProcessStop';
  }>> = [];
  const cleanup = {
    runtime: vi.fn(() => {
      events.push('cleanup:runtime');
    }),
    stop: vi.fn(async () => {
      if (
        input.stopResultStatus
        && input.stopResultStatus !== 'stopped'
      ) {
        events.push(`cleanup:stop:${input.stopResultStatus}`);
        return { status: input.stopResultStatus };
      }
      for (
        const owned of ownedCleanups
          .filter((entry) => entry.phase === 'beforeProcessStop')
          .reverse()
      ) {
        await owned.cleanup();
      }
      events.push('cleanup:stop');
      for (
        const owned of ownedCleanups
          .filter((entry) => entry.phase === 'afterProcessStop')
          .reverse()
      ) {
        await owned.cleanup();
      }
      return { status: 'stopped' as const };
    }),
    retire: vi.fn(async () => {
      events.push('cleanup:retire');
    }),
    materialization: vi.fn(() => {
      events.push('cleanup:materialization');
    }),
  };
  const startOwned = vi.fn(async (startInput: Parameters<
    Parameters<typeof prepareManagedProviderEndpointLaunch>[0]['localServices']['startOwned']
  >[0]) => {
    events.push('start');
    if (startInput.declaration.launch.kind !== 'binary') {
      throw new Error('Expected the managed Provider runtime launch to resolve to a binary');
    }
    await startInput.exec.spawn(startInput.declaration.launch, {
      signal: launchAbortController.signal,
    });
    return currentRun;
  });
  const readOwnedRun = vi.fn(() => currentRun);
  const registerOwnedCleanup = vi.fn((
    _run: TrustedManagedLocalServiceOwnedRun,
    cleanup: () => void | Promise<void>,
    options: Readonly<{
      phase?: 'beforeProcessStop' | 'afterProcessStop';
    }> = {},
  ) => {
    ownedCleanups.push({
      cleanup,
      phase: options.phase ?? 'afterProcessStop',
    });
    return true;
  });
  const scope = createProviderLaunchResourceScope();
  const exec: Pick<ExecRuntimeServiceV1, 'spawn'> = {
    spawn: vi.fn(async () => {
      events.push('spawn');
      return processHandle();
    }),
  };
  const requestAuth = {
    resolvePurposeUse: (requested: QualifiedConnectedAccountPurposeV1) => (
      JSON.stringify(requested) === JSON.stringify(purpose)
        ? { binding: purposeBinding, use: requestAuthUse }
        : null
    ),
    listPurposeUses: () => [{ binding: purposeBinding, use: requestAuthUse }],
  };
  const authorizationAttempt = {
    deployment: { kind: 'managedLocal' as const },
    authorization: {
      deployment: {
        kind: 'managedLocal' as const,
        contribution: resolvedContribution,
        implementation: input.authorizationDeployment ?? managedDeployment(),
      },
      ticket: {
        connectionId: 'pc_cliproxyapi',
        machineId: 'machine-a',
      },
      binding: {
        endpoint: {
          protocol: 'openai-responses' as const,
        },
      },
    },
    isAuthorizationCurrent: () => authorizationCurrent,
    revalidateBeforeEffect: vi.fn(async (): Promise<
      { ok: true } | { ok: false; error: never }
    > => {
      events.push('authorize');
      return { ok: true as const };
    }),
  };
  const dependencies = {
    readinessTimeoutMs: 30_000,
    prepareRuntime: vi.fn(async () => {
      events.push('prepare');
      return {
        materializedRootDir: '/tmp/runtime',
        materializationId: 'managed-provider-session-a',
        privateConfigPath: '/tmp/runtime/config.json',
        outputTee,
        expectedReadiness: {
          contractVersion: 'happier.cliproxyapi-managed/v1',
          sdkVersion: 'v7.2.95',
        },
        prepared: { downstreamBearer: 'runtime-only-secret' },
        cleanup: cleanup.runtime,
      };
    }),
    resolveRuntimeLaunch: vi.fn(async (): Promise<LocalServiceDeclarationV1 | null> => {
      events.push('resolve-asset');
      return {
        ...localService,
        launch: {
          kind: 'binary' as const,
          executablePath: '/opt/happier/tools/unpacked/happier-cliproxyapi-managed',
          args: ['--config', '/tmp/runtime/config.json'],
        },
      };
    }),
    validateReadiness: vi.fn(async (
      { signal }: { signal: AbortSignal },
    ): Promise<ManagedProviderEndpointReadiness> => {
      readinessSignal.value = signal;
      events.push('validate');
      return {
        contractVersion: 'happier.cliproxyapi-managed/v1',
        sdkVersion: 'v7.2.95',
        protocols: ['openai-responses' as const],
        purposes: [purpose],
      };
    }),
    activateRequestAuth: vi.fn(async (activation: Parameters<
      Parameters<typeof prepareManagedProviderEndpointLaunch>[1]['activateRequestAuth']
    >[0]) => {
      events.push('activate');
      activatedSubject = activation.subject;
      activatedHttpPort = activation.httpPort;
      return { capabilityId: 'capability-a' };
    }),
    validateRequestAuth: vi.fn((_input: Readonly<{
      subject: ConnectedAccountRequestAuthSubject;
      purpose: QualifiedConnectedAccountPurposeV1;
    }>) => undefined),
    retireRequestAuth: cleanup.retire,
    materializeAgentBinding: vi.fn(async () => {
      events.push('materialize');
      return {
        materialization: {
          endpoint: 'http://127.0.0.1:45123',
          bearer: 'runtime-only-secret',
        },
        cleanup: cleanup.materialization,
      };
    }),
  };
  const run = () => prepareManagedProviderEndpointLaunch({
    context: {
      pluginId: 'happier.provider.cliproxyapi',
      contributionId: 'cliproxyapi',
      operationId: 'spawn-operation-a',
      title: 'CLIProxyAPI',
    },
    authorizationAttempt: authorizationAttempt as never,
    managedLocalServicesEnabled: input.managedLocalServicesEnabled ?? true,
    requestAuthHttpPort: input.requestAuthHttpPort ?? 18_765,
    purposeBindings: [purposeBinding],
    requestAuth,
    ...(input.requestAuthSubject
      ? { requestAuthSubject: input.requestAuthSubject }
      : {}),
    localServices: {
      startOwned,
      readOwnedRun,
      registerOwnedCleanup,
      stopOwned: cleanup.stop,
    },
    exec,
    launchResourceScope: scope,
  }, dependencies);
  return {
    events,
    authorizationAttempt,
    cleanup,
    dependencies,
    startOwned,
    exec,
    scope,
    run,
    activatedSubject: () => activatedSubject,
    activatedHttpPort: () => activatedHttpPort,
    launchAbortController,
    outputTee,
    readinessSignal: () => readinessSignal.value,
    ownedCleanups,
    registerOwnedCleanup,
    setCurrentRun: (run: TrustedManagedLocalServiceOwnedRun | null) => {
      currentRun = run;
    },
    invalidateAuthorization: () => {
      authorizationCurrent = false;
    },
  };
}

describe('managed Provider endpoint launch', () => {
  it('denies forged external provenance and a disabled managed-service gate before every effect', async () => {
    for (const current of [
      harness({
        resolvedContribution: {
          ...contribution('external'),
          managed: contribution().managed,
          // Boundary fixture: exercise a forged external record carrying a forbidden managed facet.
        } as unknown as ResolvedProviderContribution,
      }),
      harness({ managedLocalServicesEnabled: false }),
      harness({
        authorizationDeployment: managedDeployment({
          implementationIdentity: {
            pluginId: 'happier.provider.other',
            localId: 'other',
          },
        }),
      }),
    ]) {
      await expect(current.run()).resolves.toEqual({
        ok: false,
        code: 'managed_provider_execution_denied',
      });
      expect(current.dependencies.prepareRuntime).not.toHaveBeenCalled();
      expect(current.dependencies.resolveRuntimeLaunch).not.toHaveBeenCalled();
      expect(current.startOwned).not.toHaveBeenCalled();
      expect(current.exec.spawn).not.toHaveBeenCalled();
      expect(current.events).toEqual([]);
    }
  });

  it('revalidates logical authorization before runtime preparation, asset lookup, port allocation, or spawn', async () => {
    const current = harness();
    current.authorizationAttempt.revalidateBeforeEffect.mockResolvedValueOnce({
      ok: false as const,
      error: {} as never,
    });

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_execution_denied',
    });
    expect(current.authorizationAttempt.revalidateBeforeEffect).toHaveBeenCalledOnce();
    expect(current.events).toEqual([]);
    expect(current.dependencies.prepareRuntime).not.toHaveBeenCalled();
    expect(current.dependencies.resolveRuntimeLaunch).not.toHaveBeenCalled();
    expect(current.startOwned).not.toHaveBeenCalled();
    expect(current.exec.spawn).not.toHaveBeenCalled();
  });

  it('denies launch when authorization becomes stale during the final pre-effect revalidation', async () => {
    const current = harness();
    current.authorizationAttempt.revalidateBeforeEffect.mockImplementationOnce(async () => {
      current.invalidateAuthorization();
      return { ok: true as const };
    });

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_execution_denied',
    });
    expect(current.authorizationAttempt.revalidateBeforeEffect).toHaveBeenCalledOnce();
    expect(current.dependencies.prepareRuntime).not.toHaveBeenCalled();
    expect(current.dependencies.resolveRuntimeLaunch).not.toHaveBeenCalled();
    expect(current.startOwned).not.toHaveBeenCalled();
    expect(current.exec.spawn).not.toHaveBeenCalled();
  });

  it('fails closed when the local-service owner cannot return an exact run', async () => {
    const current = harness({ startResult: null });

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_start_failed',
    });
    expect(current.events).toEqual(['authorize', 'prepare', 'resolve-asset', 'start', 'spawn']);
    expect(current.dependencies.validateReadiness).not.toHaveBeenCalled();
    expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();
    expect(current.dependencies.materializeAgentBinding).not.toHaveBeenCalled();

    await current.scope.release();
    expect(current.cleanup.runtime).toHaveBeenCalledTimes(1);
    expect(current.cleanup.stop).not.toHaveBeenCalled();
  });

  it('starts and materializes token-free, then activates only from a canonical scoped subject', async () => {
    const current = harness();
    const result = await current.run();
    current.events.push('agent-start');

    expect(result).toMatchObject({
      ok: true,
      materialization: {
        endpoint: 'http://127.0.0.1:45123',
      },
      run: {
        runId: 7,
        process: { pid: 301 },
        host: '127.0.0.1',
        port: 45_123,
      },
      activateRequestAuth: expect.any(Function),
    });
    expect(current.events).toEqual([
      'authorize',
      'prepare',
      'resolve-asset',
      'start',
      'spawn',
      'validate',
      'materialize',
      'agent-start',
    ]);
    expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();
    expect(current.activatedSubject()).toBeNull();
    expect(current.dependencies.validateRequestAuth).toHaveBeenCalledTimes(1);
    expect(current.dependencies.validateRequestAuth).toHaveBeenCalledWith({
      subject: expect.objectContaining({
        subjectId: 'managed-provider-prelaunch-validation:pc_cliproxyapi',
        resolvePurposeUse: expect.any(Function),
        listPurposeUses: expect.any(Function),
      }),
      purpose,
    });
    expect(current.readinessSignal()?.aborted).toBe(false);
    expect(current.registerOwnedCleanup).toHaveBeenCalledTimes(2);
    expect(current.exec.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'binary',
        executablePath: '/opt/happier/tools/unpacked/happier-cliproxyapi-managed',
      }),
      {
        signal: current.launchAbortController.signal,
        outputTee: current.outputTee,
      },
    );

    if (!result.ok) throw new Error('expected managed launch success');
    const canonicalSubject = {
      subjectId: 'agent-session:canonical/managed-provider',
      isCurrent: () => true,
      registerRedaction: () => undefined,
      resolvePurposeUse: current.dependencies
        .validateRequestAuth.mock.calls[0]![0].subject.resolvePurposeUse,
      listPurposeUses: () => [{
        binding: purposeBinding,
        use: requestAuthUse,
      }],
    };
    await result.activateRequestAuth(canonicalSubject);
    expect(current.events.slice(-1)).toEqual(['activate']);
    expect(current.activatedSubject()).toMatchObject({
      subjectId: 'agent-session:canonical/managed-provider/run:7',
    });
    expect(current.activatedHttpPort()).toBe(18_765);
    expect(current.activatedSubject()?.resolvePurposeUse(purpose)).toEqual({
      binding: purposeBinding,
      use: requestAuthUse,
    });
    expect(current.dependencies.validateRequestAuth).toHaveBeenCalledTimes(2);
    expect(current.registerOwnedCleanup).toHaveBeenCalledTimes(3);

    current.setCurrentRun(null);
    expect(current.activatedSubject()?.isCurrent()).toBe(false);
    current.setCurrentRun(ownedRun());
    current.invalidateAuthorization();
    expect(current.activatedSubject()?.isCurrent()).toBe(false);

    const cleanupOnExit = current.scope.transfer();
    await cleanupOnExit?.();
    await cleanupOnExit?.();
    expect(current.events.slice(-4)).toEqual([
      'cleanup:retire',
      'cleanup:stop',
      'cleanup:materialization',
      'cleanup:runtime',
    ]);
    expect(current.cleanup.materialization).toHaveBeenCalledTimes(1);
    expect(current.cleanup.retire).toHaveBeenCalledTimes(1);
    expect(current.cleanup.stop).toHaveBeenCalledTimes(1);
    expect(current.cleanup.runtime).toHaveBeenCalledTimes(1);
    expect(current.readinessSignal()?.aborted).toBe(true);
    expect(current.cleanup.materialization).toHaveBeenCalledTimes(1);
    expect(current.cleanup.retire).toHaveBeenCalledTimes(1);
    expect(current.cleanup.runtime).toHaveBeenCalledTimes(1);
  });

  it.each(['stale', 'unavailable'] as const)(
    'retains subordinate launch custody when canonical stopOwned reports %s',
    async (stopResultStatus) => {
      const current = harness({ stopResultStatus });
      const result = await current.run();
      if (!result.ok) throw new Error('expected managed launch success');
      await result.activateRequestAuth({
        subjectId: 'agent-session:canonical/managed-provider',
        isCurrent: () => true,
        registerRedaction: () => undefined,
        resolvePurposeUse:
          current.dependencies.validateRequestAuth.mock.calls[0]![0]
            .subject.resolvePurposeUse,
        listPurposeUses: () => [{
          binding: purposeBinding,
          use: requestAuthUse,
        }],
      });

      const cleanupOnExit = current.scope.transfer();
      await expect(cleanupOnExit?.()).rejects.toThrow(
        `managed_provider_stop_${stopResultStatus}`,
      );
      expect(current.events.slice(-1)).toEqual([
        `cleanup:stop:${stopResultStatus}`,
      ]);
      expect(current.cleanup.retire).not.toHaveBeenCalled();
      expect(current.cleanup.materialization).not.toHaveBeenCalled();
      expect(current.cleanup.runtime).not.toHaveBeenCalled();
    },
  );

  it('retains known-session capability activation before Agent endpoint materialization', async () => {
    const canonicalSubject = {
      subjectId: 'agent-session:known/managed-provider',
      isCurrent: () => true,
      registerRedaction: () => undefined,
      resolvePurposeUse: (requested: QualifiedConnectedAccountPurposeV1) => (
        JSON.stringify(requested) === JSON.stringify(purpose)
          ? { binding: purposeBinding, use: requestAuthUse }
          : null
      ),
      listPurposeUses: () => [{
        binding: purposeBinding,
        use: requestAuthUse,
      }],
    };
    const current = harness({ requestAuthSubject: canonicalSubject });

    await expect(current.run()).resolves.toMatchObject({ ok: true });
    expect(current.events).toEqual([
      'authorize',
      'prepare',
      'resolve-asset',
      'start',
      'spawn',
      'validate',
      'activate',
      'materialize',
    ]);
    expect(current.activatedSubject()).toMatchObject({
      subjectId: 'agent-session:known/managed-provider/run:7',
    });
  });

  it('bounds readiness waiting and stops before request-auth activation or endpoint exposure', async () => {
    const current = harness();
    const observedSignal: { value: AbortSignal | null } = { value: null };
    current.dependencies.readinessTimeoutMs = 1;
    current.dependencies.validateReadiness.mockImplementationOnce(async ({ signal }) => {
      observedSignal.value = signal;
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_readiness_invalid',
    });
    expect(observedSignal.value?.aborted).toBe(true);
    expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();
    expect(current.dependencies.materializeAgentBinding).not.toHaveBeenCalled();
    await current.scope.release();
  });

  it('validates the snapshotted purpose target before managed runtime effects', async () => {
    const current = harness();
    current.dependencies.validateRequestAuth.mockImplementationOnce(() => {
      throw new Error('request_auth_binding_unavailable');
    });

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_execution_denied',
    });
    expect(current.dependencies.prepareRuntime).not.toHaveBeenCalled();
    expect(current.startOwned).not.toHaveBeenCalled();
    expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();
  });

  it('rejects an invalid canonical request-auth port before managed runtime effects', async () => {
    const current = harness({ requestAuthHttpPort: 0 });

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_execution_denied',
    });
    expect(current.dependencies.prepareRuntime).not.toHaveBeenCalled();
    expect(current.startOwned).not.toHaveBeenCalled();
    expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();
  });

  it('rejects non-attachment hosts, mismatched run, version, protocol, and purpose readiness before activation', async () => {
    const cases: readonly Readonly<{
      run?: TrustedManagedLocalServiceOwnedRun;
      readiness?: Partial<{
        contractVersion: string;
        sdkVersion: string;
        protocols: readonly ('openai-responses' | 'anthropic')[];
        purposes: readonly QualifiedConnectedAccountPurposeV1[];
      }>;
    }>[] = [
      { run: ownedRun({ host: '0.0.0.0' }) },
      { run: ownedRun({ host: 'localhost' }) },
      { run: ownedRun({ host: '127.0.0.2' }) },
      {
        run: ownedRun({
          snapshot: {
            id: localService.id,
            phase: 'running',
            port: 45_124,
            diagnostics: [],
          },
        }),
      },
      { readiness: { sdkVersion: 'v7.2.94' } },
      { readiness: { protocols: ['anthropic'] } },
      { readiness: { purposes: [] } },
    ];

    for (const testCase of cases) {
      const current = harness({
        ...(testCase.run ? { startResult: testCase.run } : {}),
      });
      if (testCase.readiness) {
        current.dependencies.validateReadiness.mockResolvedValueOnce({
          contractVersion: 'happier.cliproxyapi-managed/v1',
          sdkVersion: 'v7.2.95',
          protocols: ['openai-responses'],
          purposes: [purpose],
          ...testCase.readiness,
        });
      }

      await expect(current.run()).resolves.toMatchObject({
        ok: false,
        code: testCase.run
          ? 'managed_provider_run_invalid'
          : 'managed_provider_readiness_invalid',
      });
      expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();
      expect(current.dependencies.materializeAgentBinding).not.toHaveBeenCalled();
      await current.scope.release();
    }
  });

  it('fails before port allocation or spawn when the packaged runtime asset is unavailable', async () => {
    const current = harness();
    current.dependencies.resolveRuntimeLaunch.mockResolvedValueOnce(null);

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_runtime_unavailable',
    });
    expect(current.events).toEqual(['authorize', 'prepare']);
    expect(current.startOwned).not.toHaveBeenCalled();
    expect(current.exec.spawn).not.toHaveBeenCalled();
    expect(current.dependencies.validateReadiness).not.toHaveBeenCalled();
    expect(current.dependencies.activateRequestAuth).not.toHaveBeenCalled();

    await current.scope.release();
    expect(current.cleanup.runtime).toHaveBeenCalledTimes(1);
    expect(current.cleanup.stop).not.toHaveBeenCalled();
  });

  it('maps an unexpected packaged runtime resolver failure without escaping the managed transaction', async () => {
    const current = harness();
    current.dependencies.resolveRuntimeLaunch.mockRejectedValueOnce(
      new Error('asset resolver failed'),
    );

    await expect(current.run()).resolves.toEqual({
      ok: false,
      code: 'managed_provider_runtime_unavailable',
    });
    expect(current.startOwned).not.toHaveBeenCalled();
    expect(current.exec.spawn).not.toHaveBeenCalled();

    await current.scope.release();
    expect(current.cleanup.runtime).toHaveBeenCalledTimes(1);
  });
});
