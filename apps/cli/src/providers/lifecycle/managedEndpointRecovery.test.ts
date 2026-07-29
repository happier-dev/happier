import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QualifiedConnectedAccountPurposeBindingV1 } from '@happier-dev/protocol';
import {
  readConnectedAccountRequestAuthCapabilityFile,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import {
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
  MANAGED_PROVIDER_RUNTIME_ADAPTER as CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER,
} from '@happier-dev/plugins-cliproxyapi';

import {
  createConnectedAccountRequestAuthSubjectRegistry,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
  removeConnectedAccountRequestAuthCapabilityFile,
  verifyConnectedAccountRequestAuthCapabilityFile,
} from '@/daemon/connectedServices/requestAuth/capabilityFile';
import {
  createLocalServicesDaemonRuntime,
} from '@/daemon/local/services/runtime';
import type {
  TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';
import {
  hashProcessCommand,
} from '@/daemon/sessionRegistry';
import { writePrivateBearerFile } from '@/daemon/privateBearerFile';
import type { ManagedProviderRuntimeAdapterV1 } from '@/providers/managed/types';
import type {
  ProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';

import {
  recoverManagedProviderEndpoint,
} from './managedEndpointRecovery';

const roots: string[] = [];

function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

const purpose = {
  consumer: {
    pluginId: 'happier.provider.cliproxyapi',
    localId: 'cliproxyapi',
  },
  purpose: 'openai-upstream',
} as const;
const binding = {
  purpose,
  target: {
    kind: 'account' as const,
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
    kind: 'packaged-runtime-binary' as const,
    directorySegments: ['tools', 'unpacked'],
    executableBaseName: 'happier-cliproxyapi-managed',
    privateConfigPathFlag: '--config',
  },
  launchMode: {
    kind: 'assignAndInject' as const,
    portPolicy: { kind: 'allocated' as const },
    environment: { inject: ['PORT' as const, 'HOST' as const] },
  },
  hostPolicy: { kind: 'loopback' as const, host: '127.0.0.1' as const },
  name: { strategy: 'fixed' as const, name: 'Managed Provider' },
  healthCheck: { kind: 'http' as const, path: '/healthz' },
  restart: { kind: 'never' as const },
  cleanup: { staleAfterMs: 60_000 },
};

function run(): TrustedManagedLocalServiceOwnedRun {
  return {
    serviceKey: 'managed-provider:session-a',
    runId: 11,
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
  };
}

function attempt(input: Readonly<{
  bindingTarget?: QualifiedConnectedAccountPurposeBindingV1['target'];
  runtimeAdapter?: ManagedProviderRuntimeAdapterV1;
}> = {}) {
  let current = true;
  const cleanupOnFailure = vi.fn(() => {
    current = false;
  });
  const fakeRuntimeAdapter = {
    v: 1 as const,
    catalogSource: {
      kind: 'transientModelEndpoint' as const,
      contractVersion: 'contract-v1',
      sdkVersion: 'sdk-v1',
    },
    prepare: vi.fn(async () => {
      throw new Error('recovery must not prepare or spawn');
    }),
    inspectRecovery: vi.fn(async () => null),
    verifyRecoveryHealth: vi.fn(() => true),
    resolveAgentEndpoint: vi.fn(() => 'http://127.0.0.1:45123/v1'),
  };
  const value = {
    deployment: { kind: 'managedLocal' as const },
    authorization: {
      deployment: {
        kind: 'managedLocal' as const,
        contribution: {
          pluginId: 'happier.provider.cliproxyapi',
          identity: purpose.consumer,
          definition: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
          provenance: 'first_party' as const,
          source: { kind: 'bundled' as const },
          managed: {
            managedEndpoint: {
              localService,
              protocols: ['openai-responses' as const],
            },
            connectedAccounts: [{
              purpose: purpose.purpose,
              service: binding.target.account.service,
              required: true,
            }],
            requestAuthUses: [{
              purpose: purpose.purpose,
              materialization: requestAuthUse.materialization,
            }],
          },
          managedRuntimeAdapter: input.runtimeAdapter ?? fakeRuntimeAdapter,
        },
        implementation: {
          kind: 'managedLocal' as const,
          implementationIdentity: purpose.consumer,
          facet: {
            managedEndpoint: {
              localService,
              protocols: ['openai-responses' as const],
            },
            connectedAccounts: [{
              purpose: purpose.purpose,
              service: binding.target.account.service,
              required: true,
            }],
            requestAuthUses: [{
              purpose: purpose.purpose,
              materialization: requestAuthUse.materialization,
            }],
          },
          purposeBindings: {
            v: 1 as const,
            bindings: [{
              ...binding,
              target: input.bindingTarget ?? binding.target,
            }],
          },
        },
      },
      ticket: {
        connectionId: 'pc_cliproxyapi',
        machineId: 'machine-a',
      },
      binding: {
        endpoint: { protocol: 'openai-responses' as const },
      },
    },
    isAuthorizationCurrent: () => current,
    cleanupOnFailure,
  } as unknown as Extract<
    ProviderSpawnAuthorizationAttempt,
    { deployment: { kind: 'managedLocal' } }
  >;
  return { value, cleanupOnFailure, runtimeAdapter: fakeRuntimeAdapter };
}

async function harness(input: Readonly<{
  health?: boolean;
  cleanupRegistrationFailureAt?: number;
  cleanupDuringFinalAuthorityCommit?: boolean;
  bindingTarget?: QualifiedConnectedAccountPurposeBindingV1['target'];
  requestAuthHttpPort?: number;
  useBundledRuntimeAdapter?: boolean;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-recovery-'));
  roots.push(root);
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const materializationId = 'managed-provider-session-a';
  const attachment = {
    v: 1 as const,
    process: {
      pid: 301,
      processStartTimeMs: 1_717_171_717_301,
      processCommandHash: 'a'.repeat(64),
    },
    endpoint: { host: '127.0.0.1' as const, port: 45_123 },
    materialization: { rootDir: root, materializationId },
  };
  const authorizationAttempt = attempt({
    ...(input.bindingTarget
      ? { bindingTarget: input.bindingTarget }
      : {}),
    ...(input.useBundledRuntimeAdapter
      ? { runtimeAdapter: CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER }
      : {}),
  });
  const oldRegistry = createConnectedAccountRequestAuthSubjectRegistry();
  const oldDescriptor = await oldRegistry.activate({
    subject: {
      subjectId: 'old-daemon-subject',
      isCurrent: () => true,
      registerRedaction: () => undefined,
      resolvePurposeUse: () => ({
        binding,
        use: requestAuthUse,
      }),
      listPurposeUses: () => [{
        binding,
        use: requestAuthUse,
      }],
    },
    materializedRootDir: root,
    materializationId,
    httpPort: 43_123,
  });
  const oldDocument =
    await readConnectedAccountRequestAuthCapabilityFile(oldDescriptor.path);
  if (input.useBundledRuntimeAdapter) {
    await CLIPROXYAPI_MANAGED_PROVIDER_RUNTIME_ADAPTER.prepare({
      materializedRootDir: root,
      materializationId,
      wrapperBuildVersion: 'test-wrapper-v1',
      downstreamBearer: 'test-downstream-bearer',
      purposes: [purpose],
      protocols: ['openai-responses'],
      modelListEnabled: false,
      requestAuth: { capabilityPath: oldDescriptor.path },
    }, {
      writeExclusive: writePrivateBearerFile,
      remove: async (path) => {
        await rm(path, { force: true });
      },
    });
  }
  const removeCapabilityFile = vi.fn(
    removeConnectedAccountRequestAuthCapabilityFile,
  );
  const registryOwner = createConnectedAccountRequestAuthSubjectRegistry({
    removeCapabilityFile,
  });
  const events: string[] = [];
  const activateRequestAuth = vi.fn(async (
    activation: Parameters<typeof registryOwner.activate>[0],
  ) => {
    events.push('request-auth:activate');
    return await registryOwner.activate(activation);
  });
  const registry = {
    ...registryOwner,
    activate: activateRequestAuth,
  };
  let currentRun: TrustedManagedLocalServiceOwnedRun | null = run();
  const beforeStop: Array<() => void | Promise<void>> = [];
  const afterStop: Array<() => void | Promise<void>> = [];
  const reattachVerifiedRun = vi.fn(async (reattachInput: {
    verifyMaterialization: () => Promise<boolean>;
    verifyExecutableArtifact?: (input: {
      observedExecutablePath: string;
      declaredExecutablePath: string;
    }) => Promise<boolean>;
    verifyReadiness?: () => Promise<boolean>;
  }) => {
    const materialization = await reattachInput.verifyMaterialization();
    const artifact = await reattachInput.verifyExecutableArtifact?.({
      observedExecutablePath:
        '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed',
      declaredExecutablePath:
        '/home/.happier/cli/current/tools/unpacked/happier-cliproxyapi-managed',
    });
    const readiness = await reattachInput.verifyReadiness?.();
    return materialization && artifact && readiness
      ? { ok: true as const, ownedRun: currentRun! }
      : { ok: false as const, reasonCode: 'proof_failed' };
  });
  const transferOwned = vi.fn(async () => {
    currentRun = null;
    return { status: 'transferred' as const };
  });
  const clearMarkerAttachment = vi.fn(async () => undefined);
  const cleanupMaterialization = vi.fn(async () => undefined);
  let cleanupRegistrationCount = 0;
  const result = await recoverManagedProviderEndpoint({
    sessionId: 'session-a',
    attachment,
    attempt: authorizationAttempt.value,
    requestAuthHttpPort: input.requestAuthHttpPort ?? 18_765,
    localServices: {
      reattachVerifiedRun: reattachVerifiedRun as never,
      readOwnedRun: () => currentRun,
      registerOwnedCleanup: (_ownedRun, cleanup, options) => {
        cleanupRegistrationCount += 1;
        events.push(`cleanup:${options?.phase ?? 'afterProcessStop'}:${cleanupRegistrationCount}`);
        if (cleanupRegistrationCount === input.cleanupRegistrationFailureAt) {
          return false;
        }
        (options?.phase === 'beforeProcessStop' ? beforeStop : afterStop)
          .push(cleanup);
        return true;
      },
      transferOwned,
      finalizeReattachedAuthority: async (_run, commit) => {
        commit();
        if (input.cleanupDuringFinalAuthorityCommit) {
          await beforeStop[0]?.();
        }
        return { ok: true as const };
      },
    },
    requestAuthRegistry: registry,
    validateRequestAuth: vi.fn(() => undefined),
    clearMarkerAttachment,
    cleanupMaterialization,
  }, {
    ...(input.useBundledRuntimeAdapter
      ? {}
      : {
          inspectRecovery: vi.fn(async () => ({
            materializedRootDir: root,
            materializationId,
            privateConfigPath: join(root, 'config.json'),
            capabilityPath: oldDescriptor.path,
            expectedHealth: {
              v: 1 as const,
              contractVersion: 'contract-v1',
              sdkVersion: 'sdk-v1',
              wrapperBuildVersion: 'A',
              protocols: ['openai-responses' as const],
              purposes: [purpose],
              modelListEnabled: false,
              materializationId,
            },
          })),
        }),
    resolveRuntimeLaunch: vi.fn(async () => ({
      ...localService,
      launch: {
        kind: 'binary' as const,
        executablePath:
          '/home/.happier/cli/current/tools/unpacked/happier-cliproxyapi-managed',
        args: ['--config', join(root, 'config.json')],
      },
    })),
    verifyArtifact: vi.fn(async () => true),
    verifyHealth: vi.fn(async () => input.health ?? true),
  });
  return {
    result,
    attachment,
    registry,
    oldDocument,
    capabilityPath: oldDescriptor.path,
    authorizationAttempt,
    beforeStop,
    afterStop,
    clearMarkerAttachment,
    cleanupMaterialization,
    reattachVerifiedRun,
    transferOwned,
    activateRequestAuth,
    removeCapabilityFile,
    events,
  };
}

describe('managed Provider endpoint recovery', () => {
  it('recovers through the bundled CLIProxyAPI adapter and canonical capability verifier', async () => {
    const current = await harness({ useBundledRuntimeAdapter: true });

    expect(current.result).toMatchObject({
      ok: true,
      facts: {
        expectedHealth: {
          contractVersion: 'happier.cliproxyapi-managed/v1',
          sdkVersion: 'v7.2.95',
          wrapperBuildVersion: 'test-wrapper-v1',
        },
      },
    });
    expect(current.reattachVerifiedRun).toHaveBeenCalledOnce();
    expect(current.activateRequestAuth).toHaveBeenCalledOnce();
  });

  it.each<QualifiedConnectedAccountPurposeBindingV1['target']>([
    {
      kind: 'account',
      account: {
        service: {
          pluginId: 'attacker.accounts',
          localId: 'same-purpose',
        },
        accountId: 'account-1',
      },
    },
    {
      kind: 'group',
      service: {
        pluginId: 'attacker.accounts',
        localId: 'same-purpose',
      },
      groupId: 'group-1',
    },
  ])('rejects a $kind purpose binding whose target service differs from the managed declaration', async (bindingTarget) => {
    const current = await harness({
      bindingTarget,
    });

    expect(current.result).toEqual({
      ok: false,
      code: 'authorization_invalid',
    });
    expect(current.reattachVerifiedRun).not.toHaveBeenCalled();
    expect(current.activateRequestAuth).not.toHaveBeenCalled();
  });

  it('does not depend on replacement-startup provider-input admission transport', async () => {
    const current = await harness();

    expect(current.result).toMatchObject({
      ok: true,
      run: { runId: 11, process: { pid: 301 } },
    });
    expect(current.activateRequestAuth.mock.calls[0]?.[0].httpPort).toBe(
      18_765,
    );
  });

  it('rejects an invalid canonical request-auth port before reattachment or activation', async () => {
    const current = await harness({ requestAuthHttpPort: 0 });

    expect(current.result).toEqual({
      ok: false,
      code: 'authorization_invalid',
    });
    expect(current.reattachVerifiedRun).not.toHaveBeenCalled();
    expect(current.activateRequestAuth).not.toHaveBeenCalled();
  });

  it('commits request-auth authority only after every required owned control is registered', async () => {
    const current = await harness();

    expect(current.result.ok).toBe(true);
    expect(current.events).toEqual([
      'cleanup:beforeProcessStop:1',
      'cleanup:afterProcessStop:2',
      'cleanup:afterProcessStop:3',
      'cleanup:afterProcessStop:4',
      'request-auth:activate',
    ]);
  });

  it('makes the staged descriptor available to owned cleanup at the final authority commit', async () => {
    const current = await harness({
      cleanupDuringFinalAuthorityCommit: true,
    });

    expect(current.result).toEqual({
      ok: false,
      code: 'request_auth_activation_failed',
    });
    await expect(readConnectedAccountRequestAuthCapabilityFile(
      current.capabilityPath,
    )).resolves.toBeNull();
    expect(current.removeCapabilityFile).toHaveBeenCalledOnce();
  });

  it('publishes no request-auth authority when any required owned control registration fails', async () => {
    const current = await harness({ cleanupRegistrationFailureAt: 4 });

    expect(current.result).toEqual({
      ok: false,
      code: 'cleanup_registration_failed',
    });
    expect(current.activateRequestAuth).not.toHaveBeenCalled();
    expect(current.registry.authenticate(
      current.oldDocument?.capability,
    )).toBeNull();
  });

  it('reattaches without spawn and atomically rotates request auth as its final authority commit', async () => {
    const current = await harness();
    expect(current.result).toMatchObject({
      ok: true,
      run: { runId: 11, process: { pid: 301 } },
    });
    expect(current.authorizationAttempt.runtimeAdapter.prepare).not.toHaveBeenCalled();
    expect(current.reattachVerifiedRun).toHaveBeenCalledOnce();
    expect(current.registry.authenticate(
      current.oldDocument?.capability,
    )).toBeNull();

    if (!current.result.ok) throw new Error('expected recovery');
    const newDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        current.result.capability.path,
      );
    expect(newDocument?.capability).not.toBe(current.oldDocument?.capability);
    expect(current.registry.authenticate(
      newDocument?.capability,
    )?.subjectId).toContain('managed-provider-recovery');

    for (const cleanup of current.beforeStop) await cleanup();
    for (const cleanup of [...current.afterStop].reverse()) await cleanup();
    expect(current.clearMarkerAttachment).toHaveBeenCalledOnce();
    expect(current.cleanupMaterialization).toHaveBeenCalledOnce();
  });

  it('leaves the survivor untouched and publishes no authority when proof fails', async () => {
    const current = await harness({ health: false });
    expect(current.result).toEqual({
      ok: false,
      code: 'runtime_reattach_failed',
      detail: 'proof_failed',
    });
    expect(current.activateRequestAuth).not.toHaveBeenCalled();
    expect(current.transferOwned).not.toHaveBeenCalled();
    expect(current.clearMarkerAttachment).not.toHaveBeenCalled();
    expect(current.cleanupMaterialization).not.toHaveBeenCalled();
  });

  it('preserves the capability file as passive retry evidence when authority becomes stale after activation', async () => {
    const current = await harness();
    if (!current.result.ok) throw new Error('expected recovery');
    const before = await readConnectedAccountRequestAuthCapabilityFile(
      current.result.capability.path,
    );
    current.authorizationAttempt.cleanupOnFailure();

    expect(current.registry.authenticate(before?.capability)).toBeNull();
    await expect(readConnectedAccountRequestAuthCapabilityFile(
      current.result.capability.path,
    )).resolves.toEqual(before);
    expect(current.transferOwned).not.toHaveBeenCalled();
    expect(current.clearMarkerAttachment).not.toHaveBeenCalled();
    expect(current.cleanupMaterialization).not.toHaveBeenCalled();
  });

  it('publishes no request-auth authority when the exact process identity changes while capability verification awaits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-recovery-final-proof-'));
    roots.push(root);
    if (process.platform !== 'win32') await chmod(root, 0o700);
    const materializationId = 'managed-provider-session-final-proof';
    const privateConfigPath = join(root, 'config.json');
    await writeFile(privateConfigPath, '{}\n', { mode: 0o600 });
    const observedExecutablePath =
      '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed';
    const declaredExecutablePath =
      '/home/.happier/cli/current/tools/unpacked/happier-cliproxyapi-managed';
    const processStartTimeMs = 1_717_171_717_902;
    const command = `${observedExecutablePath} --config ${privateConfigPath}`;
    const attachment = {
      v: 1 as const,
      process: {
        pid: 902,
        processStartTimeMs,
        processCommandHash: hashProcessCommand(command),
      },
      endpoint: { host: '127.0.0.1' as const, port: 45_902 },
      materialization: { rootDir: root, materializationId },
    };
    const recoveryFacts = {
      materializedRootDir: root,
      materializationId,
      privateConfigPath,
      capabilityPath: join(root, 'request-auth-capability.json'),
      expectedHealth: {
        v: 1 as const,
        contractVersion: 'contract-v1',
        sdkVersion: 'sdk-v1',
        wrapperBuildVersion: 'A',
        protocols: ['openai-responses' as const],
        purposes: [purpose],
        modelListEnabled: false,
        materializationId,
      },
    };
    const resolvedDeclaration = {
      ...localService,
      launch: {
        kind: 'binary' as const,
        executablePath: declaredExecutablePath,
        args: ['--config', privateConfigPath],
      },
    };
    let identityReplaced = false;
    let scanCount = 0;
    const processHandle = {
      pid: attachment.process.pid,
      exit: new Promise<never>(() => {}),
      writeStdin: vi.fn(async () => undefined),
      kill: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const runtime = createLocalServicesDaemonRuntime({
      machineId: 'machine-a',
      inventoryEnabled: () => true,
      scan: async () => {
        scanCount += 1;
        const currentCommand = identityReplaced
          ? '/tmp/replacement-managed-provider --foreign-config'
          : command;
        return {
          listeners: [{
            address: attachment.endpoint.host,
            port: attachment.endpoint.port,
            protocol: 'tcp' as const,
            pid: attachment.process.pid,
          }],
          processes: new Map([[
            attachment.process.pid,
            {
              pid: attachment.process.pid,
              ppid: 1,
              processStartTimeMs: identityReplaced
                ? processStartTimeMs + 1
                : processStartTimeMs,
              command: currentCommand,
              executablePath: identityReplaced
                ? '/tmp/replacement-managed-provider'
                : observedExecutablePath,
              cwd: root,
            },
          ]]),
          workspaces: [],
          diagnostics: [],
        };
      },
      startLoop: false,
      managedLocalServices: {
        exec: {
          spawn: vi.fn(async () => {
            throw new Error('recovery must not spawn');
          }),
        },
        reattachProcess: vi.fn(async () => processHandle),
        healthProbe: vi.fn(async () => true),
      },
    });
    const verificationStarted = createDeferred();
    const resumeVerification = createDeferred();
    let stagedCapabilityPath: string | null = null;
    const registry =
      createConnectedAccountRequestAuthSubjectRegistry({
        verifyCapabilityFile: async (input) => {
          stagedCapabilityPath = input.path;
          verificationStarted.resolve();
          await resumeVerification.promise;
          return await verifyConnectedAccountRequestAuthCapabilityFile(input);
        },
      });
    const authorizationAttempt = attempt();
    const recovery = recoverManagedProviderEndpoint({
      sessionId: 'session-a',
      attachment,
      attempt: authorizationAttempt.value,
      requestAuthHttpPort: 18_765,
      localServices: runtime.trustedManagedLocalServices,
      requestAuthRegistry: registry,
      validateRequestAuth: vi.fn(() => undefined),
      clearMarkerAttachment: vi.fn(async () => undefined),
      cleanupMaterialization: vi.fn(async () => undefined),
    }, {
      inspectRecovery: vi.fn(async () => recoveryFacts),
      resolveRuntimeLaunch: vi.fn(async () => resolvedDeclaration),
      verifyArtifact: vi.fn(async (artifact) => (
        artifact.observedExecutablePath === observedExecutablePath
      )),
      verifyHealth: vi.fn(async () => true),
    });

    await verificationStarted.promise;
    if (!stagedCapabilityPath) {
      throw new Error('expected a staged request-auth capability');
    }
    const stagedDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        stagedCapabilityPath,
      );
    expect(stagedDocument).not.toBeNull();
    identityReplaced = true;
    resumeVerification.resolve();
    const result = await recovery;
    const finalDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        stagedCapabilityPath,
      );
    const observation = {
      result,
      authenticatedSubjectId:
        registry.authenticate(stagedDocument?.capability)?.subjectId ?? null,
      ownedRun: runtime.trustedManagedLocalServices.readOwnedRun({
        context: {
          pluginId: purpose.consumer.pluginId,
          contributionId: purpose.consumer.localId,
          sessionId: 'session-a',
          title: CLIPROXYAPI_PROVIDER_CONTRIBUTION.name,
        },
        serviceId: resolvedDeclaration.id,
      }),
      finalCapabilityPresent: finalDocument !== null,
      scanCount,
    };
    await runtime.stop({ disposition: 'transfer' });

    expect(observation).toEqual({
      result: {
        ok: false,
        code: 'request_auth_activation_failed',
      },
      authenticatedSubjectId: null,
      ownedRun: null,
      finalCapabilityPresent: false,
      scanCount: 4,
    });
    expect(processHandle.kill).not.toHaveBeenCalled();
    expect(processHandle.dispose).not.toHaveBeenCalled();
  });

  it('composes exact survivor adoption across planned takeover and unexpected replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-recovery-composed-'));
    roots.push(root);
    if (process.platform !== 'win32') await chmod(root, 0o700);
    const materializationId = 'managed-provider-session-composed';
    const privateConfigPath = join(root, 'config.json');
    await writeFile(privateConfigPath, '{}\n', { mode: 0o600 });
    const observedExecutablePath =
      '/home/.happier/cli/versions/A/tools/unpacked/happier-cliproxyapi-managed';
    const declaredExecutablePath =
      '/home/.happier/cli/current/tools/unpacked/happier-cliproxyapi-managed';
    const processStartTimeMs = 1_717_171_717_901;
    const command = `${observedExecutablePath} --config ${privateConfigPath}`;
    const attachment = {
      v: 1 as const,
      process: {
        pid: 901,
        processStartTimeMs,
        processCommandHash: hashProcessCommand(command),
      },
      endpoint: { host: '127.0.0.1' as const, port: 45_901 },
      materialization: { rootDir: root, materializationId },
    };
    const recoveryFacts = {
      materializedRootDir: root,
      materializationId,
      privateConfigPath,
      capabilityPath: join(root, 'request-auth-capability.json'),
      expectedHealth: {
        v: 1 as const,
        contractVersion: 'contract-v1',
        sdkVersion: 'sdk-v1',
        wrapperBuildVersion: 'A',
        protocols: ['openai-responses' as const],
        purposes: [purpose],
        modelListEnabled: false,
        materializationId,
      },
    };
    const resolvedDeclaration = {
      ...localService,
      launch: {
        kind: 'binary' as const,
        executablePath: declaredExecutablePath,
        args: ['--config', privateConfigPath],
      },
    };
    const processHandles: Array<{
      pid: number;
      exit: Promise<never>;
      writeStdin: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }> = [];
    const reattachProcesses: Array<ReturnType<typeof vi.fn>> = [];
    const createRuntime = () => {
      const processHandle = {
        pid: attachment.process.pid,
        exit: new Promise<never>(() => {}),
        writeStdin: vi.fn(async () => undefined),
        kill: vi.fn(),
        dispose: vi.fn(async () => undefined),
      };
      const reattachProcess = vi.fn(async () => processHandle);
      processHandles.push(processHandle);
      reattachProcesses.push(reattachProcess);
      return createLocalServicesDaemonRuntime({
        machineId: 'machine-a',
        inventoryEnabled: () => true,
        scan: async () => ({
          listeners: [{
            address: attachment.endpoint.host,
            port: attachment.endpoint.port,
            protocol: 'tcp' as const,
            pid: attachment.process.pid,
          }],
          processes: new Map([[
            attachment.process.pid,
            {
              pid: attachment.process.pid,
              ppid: 1,
              processStartTimeMs,
              command,
              executablePath: observedExecutablePath,
              cwd: root,
            },
          ]]),
          workspaces: [],
          diagnostics: [],
        }),
        startLoop: false,
        managedLocalServices: {
          exec: {
            spawn: vi.fn(async () => {
              throw new Error('recovery must not spawn');
            }),
          },
          reattachProcess,
          healthProbe: vi.fn(async () => true),
        },
      });
    };
    const recover = async (input: Readonly<{
      runtime: ReturnType<typeof createRuntime>;
      authorizationAttempt: ReturnType<typeof attempt>;
      registry: ReturnType<typeof createConnectedAccountRequestAuthSubjectRegistry>;
      clearMarkerAttachment?: () => Promise<void>;
      cleanupMaterialization?: () => Promise<void>;
    }>) => {
      const inspectRecovery = vi.fn(async () => recoveryFacts);
      const resolveRuntimeLaunch = vi.fn(async () => resolvedDeclaration);
      const verifyArtifact = vi.fn(async (artifact: {
        observedExecutablePath: string;
      }) => artifact.observedExecutablePath === observedExecutablePath);
      const verifyHealth = vi.fn(async () => true);
      const validateRequestAuth = vi.fn(() => undefined);
      const result = await recoverManagedProviderEndpoint({
        sessionId: 'session-a',
        attachment,
        attempt: input.authorizationAttempt.value,
        requestAuthHttpPort: 18_765,
        localServices: input.runtime.trustedManagedLocalServices,
        requestAuthRegistry: input.registry,
        validateRequestAuth,
        clearMarkerAttachment:
          input.clearMarkerAttachment ?? vi.fn(async () => undefined),
        cleanupMaterialization:
          input.cleanupMaterialization ?? vi.fn(async () => undefined),
      }, {
        inspectRecovery,
        resolveRuntimeLaunch,
        verifyArtifact,
        verifyHealth,
      });
      return {
        result,
        inspectRecovery,
        resolveRuntimeLaunch,
        verifyArtifact,
        verifyHealth,
        validateRequestAuth,
      };
    };

    const initialRegistry =
      createConnectedAccountRequestAuthSubjectRegistry();
    const initialDescriptor = await initialRegistry.activate({
      subject: {
        subjectId: 'initial-daemon-subject',
        isCurrent: () => true,
        registerRedaction: () => undefined,
        resolvePurposeUse: () => ({ binding, use: requestAuthUse }),
        listPurposeUses: () => [{ binding, use: requestAuthUse }],
      },
      materializedRootDir: root,
      materializationId,
      httpPort: 43_123,
    });
    const initialDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        initialDescriptor.path,
      );

    const plannedRuntime = createRuntime();
    const plannedRegistry =
      createConnectedAccountRequestAuthSubjectRegistry();
    const plannedAttempt = attempt();
    const planned = await recover({
      runtime: plannedRuntime,
      authorizationAttempt: plannedAttempt,
      registry: plannedRegistry,
    });
    expect(planned.result).toMatchObject({
      ok: true,
      run: {
        serviceKey: expect.any(String),
        process: attachment.process,
        host: attachment.endpoint.host,
        port: attachment.endpoint.port,
      },
      facts: recoveryFacts,
    });
    if (!planned.result.ok) throw new Error('expected planned recovery');
    const plannedDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        planned.result.capability.path,
      );
    expect(plannedDocument?.capability).not.toBe(
      initialDocument?.capability,
    );
    expect(plannedRegistry.authenticate(initialDocument?.capability)).toBeNull();
    expect(
      plannedRegistry.authenticate(plannedDocument?.capability)?.subjectId,
    ).toContain('managed-provider-recovery');
    expect(planned.inspectRecovery).toHaveBeenCalledTimes(2);
    expect(planned.resolveRuntimeLaunch).toHaveBeenCalledOnce();
    expect(planned.verifyArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ observedExecutablePath }),
    );
    expect(planned.verifyHealth).toHaveBeenCalledOnce();
    expect(planned.validateRequestAuth).toHaveBeenCalledWith(
      expect.objectContaining({ purpose }),
    );
    expect(plannedAttempt.runtimeAdapter.prepare).not.toHaveBeenCalled();
    await plannedRuntime.stop({ disposition: 'transfer' });
    plannedAttempt.cleanupOnFailure();
    expect(processHandles[0]?.dispose).not.toHaveBeenCalled();
    expect(processHandles[0]?.kill).not.toHaveBeenCalled();

    const replacementRuntime = createRuntime();
    const staleAttempt = attempt();
    staleAttempt.cleanupOnFailure();
    const stale = await recover({
      runtime: replacementRuntime,
      authorizationAttempt: staleAttempt,
      registry: createConnectedAccountRequestAuthSubjectRegistry(),
    });
    expect(stale.result).toEqual({
      ok: false,
      code: 'authorization_invalid',
    });
    const wrongPurposeAttempt = attempt({
      bindingTarget: {
        kind: 'account',
        account: {
          service: {
            pluginId: 'attacker.accounts',
            localId: 'same-purpose',
          },
          accountId: 'account-1',
        },
      },
    });
    const wrongPurpose = await recover({
      runtime: replacementRuntime,
      authorizationAttempt: wrongPurposeAttempt,
      registry: createConnectedAccountRequestAuthSubjectRegistry(),
    });
    expect(wrongPurpose.result).toEqual({
      ok: false,
      code: 'authorization_invalid',
    });
    expect(reattachProcesses[1]).not.toHaveBeenCalled();

    const replacementRegistry =
      createConnectedAccountRequestAuthSubjectRegistry();
    const replacementAttempt = attempt();
    const replacement = await recover({
      runtime: replacementRuntime,
      authorizationAttempt: replacementAttempt,
      registry: replacementRegistry,
    });
    expect(replacement.result).toMatchObject({
      ok: true,
      run: {
        process: attachment.process,
        host: attachment.endpoint.host,
        port: attachment.endpoint.port,
      },
      facts: recoveryFacts,
    });
    if (!replacement.result.ok) {
      throw new Error('expected unexpected-replacement recovery');
    }
    expect(replacement.result.run.serviceKey).toBe(
      planned.result.run.serviceKey,
    );
    const replacementDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        replacement.result.capability.path,
      );
    expect(replacementDocument?.capability).not.toBe(
      plannedDocument?.capability,
    );
    expect(replacementRegistry.authenticate(plannedDocument?.capability))
      .toBeNull();
    expect(
      replacementRegistry.authenticate(replacementDocument?.capability)
        ?.subjectId,
    ).toContain('managed-provider-recovery');
    expect(replacementAttempt.runtimeAdapter.prepare).not.toHaveBeenCalled();
    expect(reattachProcesses[1]).toHaveBeenCalledOnce();
    expect(processHandles[0]?.dispose).not.toHaveBeenCalled();
    expect(processHandles[1]?.dispose).not.toHaveBeenCalled();

    const finalClearMarkerAttachment = vi.fn(async () => undefined);
    const finalCleanupMaterialization = vi.fn(async () => {
      await rm(root, { recursive: true, force: true });
    });
    replacementAttempt.cleanupOnFailure();
    const finalRuntime = createRuntime();
    const finalRegistry =
      createConnectedAccountRequestAuthSubjectRegistry();
    const finalAttempt = attempt();
    const finalRecovery = await recover({
      runtime: finalRuntime,
      authorizationAttempt: finalAttempt,
      registry: finalRegistry,
      clearMarkerAttachment: finalClearMarkerAttachment,
      cleanupMaterialization: finalCleanupMaterialization,
    });
    expect(finalRecovery.result).toMatchObject({
      ok: true,
      run: {
        process: attachment.process,
        host: attachment.endpoint.host,
        port: attachment.endpoint.port,
      },
      facts: recoveryFacts,
    });
    if (!finalRecovery.result.ok) {
      throw new Error('expected final recovery');
    }
    expect(finalRecovery.result.run.serviceKey).toBe(
      planned.result.run.serviceKey,
    );
    const finalDocument =
      await readConnectedAccountRequestAuthCapabilityFile(
        finalRecovery.result.capability.path,
      );
    expect(finalDocument?.capability).not.toBe(
      replacementDocument?.capability,
    );
    expect(finalRegistry.authenticate(replacementDocument?.capability))
      .toBeNull();
    expect(reattachProcesses[2]).toHaveBeenCalledOnce();

    await replacementRuntime.stop({ disposition: 'transfer' });
    expect(processHandles[1]?.dispose).not.toHaveBeenCalled();
    expect(processHandles[1]?.kill).not.toHaveBeenCalled();
    await finalRuntime.stop();
    expect(processHandles[2]?.dispose).toHaveBeenCalledOnce();
    expect(processHandles[2]?.kill).not.toHaveBeenCalled();
    expect(finalClearMarkerAttachment).toHaveBeenCalledOnce();
    expect(finalCleanupMaterialization).toHaveBeenCalledOnce();
    expect(finalRegistry.authenticate(finalDocument?.capability)).toBeNull();
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
