import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import axios from 'axios';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { ForkResultV1, ForkSurfaceV1 } from '@happier-dev/agents';
import { accountSettingsParse, sealEncryptedDataKeyEnvelopeV1, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import {
  buildCodexAgentRuntimeDescriptorV1 as buildCodexAgentRuntimeDescriptor,
  buildOpenCodeAgentRuntimeDescriptorV1 as buildOpenCodeAgentRuntimeDescriptor,
} from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { collectBugReportMachineDiagnosticsSnapshot } from '@/diagnostics/bugReportMachineDiagnostics';
import { removeExecutionRunMarker, writeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import { registerMachineRpcHandlers as registerMachineRpcHandlersImpl } from './rpcHandlers';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import type { Credentials } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import { createExternalSessionOperationExclusion } from '@/session/external/operationExclusion';

const {
  readCredentialsMock,
  psListMock,
  resolveExecutionSurfacesMock,
  evaluateAgentSessionCapabilitySupportMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn<() => Promise<Credentials | null>>(async () => null),
  psListMock: vi.fn(async () => [] as any[]),
  resolveExecutionSurfacesMock: vi.fn<
    (backendId?: string | null) => Promise<BackendExecutionSurfaces>
  >(),
  evaluateAgentSessionCapabilitySupportMock: vi.fn<() => 'supported' | 'unsupported'>(
    () => 'unsupported',
  ),
}));

const { updateSessionMetadataWithRetryMock } = vi.hoisted(() => ({
  updateSessionMetadataWithRetryMock: vi.fn(async (args: any) => ({
    version: Number(args?.rawSession?.metadataVersion ?? 0) + 1,
    metadata: (args?.updater ? args.updater({}) : {}) as Record<string, unknown>,
  })),
}));

const { createCodexAppServerClientMock } = vi.hoisted(() => ({
  createCodexAppServerClientMock: vi.fn(async () => ({
    request: vi.fn(async () => ({ threadId: 'codex-thread-forked' })),
    notify: vi.fn(async () => {}),
    registerRequestHandler: vi.fn(() => () => {}),
    registerNotificationHandler: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  })),
}));

const { fetchServerFeaturesSnapshotMock } = vi.hoisted(() => ({
  fetchServerFeaturesSnapshotMock: vi.fn(async () => ({
    status: 'ready',
    features: {
      capabilities: {
        encryption: {
          storagePolicy: 'plaintext_only',
        },
      },
    },
  })),
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readCredentials: readCredentialsMock,
    // Filesystem boundary: avoid noisy retries when configuration is mocked.
    readDaemonState: async () => null,
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://example.invalid',
    apiServerUrl: 'http://example.invalid',
    activeServerId: 'cloud',
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    publicReleaseRing: 'stable',
    daemonStateFile: '/tmp/happier-test-home/daemon.state.json',
    isDaemonProcess: false,
    replaySeedMaxChars: 50_000,
    replaySeedCandidateLimit: 500,
  },
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@happier-dev/plugins-codex/agent/runtime/appServer/client', () => ({
  createCodexAppServerClient: createCodexAppServerClientMock,
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: fetchServerFeaturesSnapshotMock,
}));

vi.mock('@happier-dev/agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/agents')>(),
  evaluateAgentSessionCapabilitySupport: evaluateAgentSessionCapabilitySupportMock,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
}));

function emptyExecutionSurfaces(
  overrides: Partial<BackendExecutionSurfaces> = {},
): BackendExecutionSurfaces {
  return {
    terminalRuntime: null,
    externalSession: null,
    attach: null,
    handoff: null,
    fork: null,
    checkpoint: null,
    ...overrides,
  };
}

function mockForkSurfaceOnce(
  implementation: NonNullable<ForkSurfaceV1['fork']>,
): NonNullable<ForkSurfaceV1['fork']> {
  const fork = vi.fn(implementation);
  resolveExecutionSurfacesMock.mockResolvedValueOnce(emptyExecutionSurfaces({
    fork: { fork },
  }));
  return fork;
}

function mockReplayChildLaunchSurfaceOnce(
  implementation: NonNullable<ForkSurfaceV1['resolveReplayChildLaunch']>,
): NonNullable<ForkSurfaceV1['resolveReplayChildLaunch']> {
  const resolveReplayChildLaunch = vi.fn(implementation);
  resolveExecutionSurfacesMock.mockResolvedValueOnce(emptyExecutionSurfaces({
    fork: { resolveReplayChildLaunch },
  }));
  return resolveReplayChildLaunch;
}

function createOpenCodeForkResult(params: Readonly<{
  providerSessionId: string;
  backendMode?: 'acp' | 'server';
  serverBaseUrl?: string;
  serverBaseUrlExplicit?: boolean;
  environmentVariables?: Record<string, string>;
}>): ForkResultV1 {
  const backendMode = params.backendMode ?? 'server';
  return {
    providerSessionId: params.providerSessionId,
    launch: {
      ...(params.environmentVariables
        ? { environmentVariables: params.environmentVariables }
        : {}),
      sessionStateUpdates: [
        {
          fieldId: 'identity.runtimeDescriptor',
          value: buildOpenCodeAgentRuntimeDescriptor({
            backendMode,
            providerSessionId: params.providerSessionId,
            serverBaseUrl: params.serverBaseUrl,
            serverBaseUrlExplicit: params.serverBaseUrlExplicit,
          }),
        },
        {
          fieldId: 'identity.providerSessionId',
          value: params.providerSessionId,
        },
      ],
    },
  };
}

function createCodexForkResult(params: Readonly<{
  providerSessionId: string;
  backendMode?: 'acp' | 'appServer';
  home?: 'connectedService' | 'user';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
  homePath?: string;
  environmentVariables?: Record<string, string>;
}>): ForkResultV1 {
  return {
    providerSessionId: params.providerSessionId,
    launch: {
      ...(params.environmentVariables
        ? { environmentVariables: params.environmentVariables }
        : {}),
      sessionStateUpdates: [
        {
          fieldId: 'identity.runtimeDescriptor',
          value: buildCodexAgentRuntimeDescriptor({
            backendMode: params.backendMode ?? 'appServer',
            providerSessionId: params.providerSessionId,
            home: params.home,
            connectedServiceId: params.connectedServiceId,
            connectedServiceProfileId: params.connectedServiceProfileId,
            connectedServiceGroupId: params.connectedServiceGroupId,
            homePath: params.homePath,
          }),
        },
        {
          fieldId: 'identity.providerSessionId',
          value: params.providerSessionId,
        },
      ],
    },
  };
}

function mockAxiosGetSequenceWithSystemRecordMiss(
  responses: readonly unknown[],
) {
  let responseIndex = 0;
  return vi.spyOn(axios, 'get').mockImplementation(async (url: unknown) => {
    if (String(url).includes('/system-records/latest')) {
      return { status: 200, data: { record: null } } as any;
    }
    const response = responses[responseIndex];
    responseIndex += 1;
    if (response === undefined) {
      throw new Error(`Unexpected axios.get request in RPC fixture: ${String(url)}`);
    }
    return response as any;
  });
}

function registerMachineRpcHandlers(
  params: Parameters<typeof registerMachineRpcHandlersImpl>[0],
): ReturnType<typeof registerMachineRpcHandlersImpl> {
  let latestSpawnOptions: Record<string, any> | null = null;
  return registerMachineRpcHandlersImpl({
    ...params,
    handlers: {
      ...params.handlers,
      spawnSession: async (options) => {
        latestSpawnOptions = options as Record<string, any>;
        return await params.handlers.spawnSession(options);
      },
    },
    deps: {
      ...params.deps,
      resolveExecutionSurfaces: resolveExecutionSurfacesMock,
      awaitAgentSessionOpen: params.deps?.awaitAgentSessionOpen ?? (async ({ sessionId }) => {
        const nativeForkSource = latestSpawnOptions?.nativeForkSource;
        if (!nativeForkSource) {
          return { status: 'timeout' as const };
        }
        return {
          status: 'opened' as const,
          request: {
            kind: 'fork' as const,
            sessionId,
            cwd: latestSpawnOptions?.directory,
            source: nativeForkSource,
          },
        };
      }),
    },
  });
}

describe('registerMachineRpcHandlers', () => {
  beforeEach(() => {
    // Many tests spy on axios.get; restore between tests so mockResolvedValueOnce
    // chains cannot leak across cases.
    vi.restoreAllMocks();
    readCredentialsMock.mockReset();
    psListMock.mockReset();
    resolveExecutionSurfacesMock.mockReset();
    resolveExecutionSurfacesMock.mockResolvedValue(emptyExecutionSurfaces());
    evaluateAgentSessionCapabilitySupportMock.mockReset();
    evaluateAgentSessionCapabilitySupportMock.mockReturnValue('unsupported');
    updateSessionMetadataWithRetryMock.mockClear();
    createCodexAppServerClientMock.mockReset();
    createCodexAppServerClientMock.mockResolvedValue({
      request: vi.fn(async () => ({ threadId: 'codex-thread-forked' })),
      notify: vi.fn(async () => {}),
      registerRequestHandler: vi.fn(() => () => {}),
      registerNotificationHandler: vi.fn(() => () => {}),
      dispose: vi.fn(async () => {}),
    } as any);
    fetchServerFeaturesSnapshotMock.mockClear();
    fetchServerFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: {
        capabilities: {
          encryption: {
            storagePolicy: 'plaintext_only',
          },
        },
      },
    } as any);
    setActiveAccountSettingsSnapshot({
      source: 'none',
      settings: accountSettingsParse({}),
      settingsVersion: 0,
      loadedAtMs: 0,
      settingsSecretsReadKeys: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers a spawn nonce resolver for recovering timed-out session creation', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;
    const resolveSpawnSessionByNonce = vi.fn(async (_spawnNonce: string) => ({
      status: 'success',
      sessionId: 'session-from-nonce',
    } as const));

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
        resolveSpawnSessionByNonce,
      },
    });

    const handler = registered.get('daemon.spawnSession.resolveByNonce');
    expect(handler).toBeDefined();
    await expect(handler!({ spawnNonce: ' spawn-nonce-1 ' })).resolves.toEqual({
      status: 'success',
      sessionId: 'session-from-nonce',
    });
    expect(resolveSpawnSessionByNonce).toHaveBeenCalledWith('spawn-nonce-1');
  });

  it('drops empty legacy model input when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelId: '',
      modelUpdatedAt: 123,
    });

    const [spawnOptions] = spawnSession.mock.calls[0] ?? [];
    expect(spawnOptions).toEqual(expect.objectContaining({ modelSelection: undefined }));
    expect(spawnOptions).not.toHaveProperty('modelId');
    expect(spawnOptions).not.toHaveProperty('modelUpdatedAt');
  });

  it('forwards account settings version hints when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      accountSettingsVersionHint: 295,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      accountSettingsVersionHint: 295,
    }));
  });

  it('drops whitespace-only legacy model input when resuming a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      directory: '/tmp',
      sessionId: 'sess_old',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      modelId: '   ',
      modelUpdatedAt: 456,
    });

    const [spawnOptions] = spawnSession.mock.calls[0] ?? [];
    expect(spawnOptions).toEqual(expect.objectContaining({ modelSelection: undefined }));
    expect(spawnOptions).not.toHaveProperty('modelId');
    expect(spawnOptions).not.toHaveProperty('modelUpdatedAt');
  });

  it('passes through environmentVariables when resuming a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      directory: '/tmp',
      sessionId: 'sess_old',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_old',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
      },
    }));
  });

  it('does not forward machine rpc auth token into daemon spawn options', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      token: 'happy-account-token',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
    }));
    expect(spawnSession).toHaveBeenCalledTimes(1);
    const firstSpawnCall = spawnSession.mock.calls.at(0) as readonly unknown[] | undefined;
    const firstSpawnOptions = firstSpawnCall?.[0];
    expect(firstSpawnOptions).toBeDefined();
    expect(firstSpawnOptions).not.toHaveProperty('token');
  });

  it('forwards savePreparedTargetLocalMetadata into session handoff registration', async () => {
    const sessionHandoff = await import('./sessionHandoff/handlers');
    const registerMachineSessionHandoffRpcHandlersSpy = vi
      .spyOn(sessionHandoff, 'registerMachineSessionHandoffRpcHandlers')
      .mockImplementation(() => {});
    const rpcHandlerManager = {
      registerHandler: vi.fn(),
    } as any;
    const savePreparedTargetLocalMetadata = vi.fn(async () => {});

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
        savePreparedTargetLocalMetadata,
      } as any,
    });

    expect(registerMachineSessionHandoffRpcHandlersSpy).toHaveBeenCalledTimes(1);
    expect(registerMachineSessionHandoffRpcHandlersSpy).toHaveBeenCalledWith(expect.objectContaining({
      rpcHandlerManager,
      savePreparedTargetLocalMetadata,
    }));
  });

  it('injects one daemon operation exclusion owner into external-session and handoff handlers', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-machine-rpc-operation-owner-'));
    const operationExclusion = createExternalSessionOperationExclusion({
      activeServerDir,
      ownerId: 'machine-rpc-operation-owner',
      claimMutationLockAcquisitionTimeoutMs: 10_000,
    });
    const externalSessions = await import('./rpcHandlers.externalSessions');
    const sessionHandoff = await import('./sessionHandoff/handlers');
    const registerExternalSessionsSpy = vi
      .spyOn(externalSessions, 'registerMachineExternalSessionsRpcHandlers')
      .mockImplementation(() => ({
        hostExternalSessionActionExecutor: {
          execute: async () => ({
            ok: false as const,
            errorCode: 'test_fixture_unavailable',
            error: 'External Action ingress is not exercised by this fixture.',
          }),
        },
        dispose: async () => {},
      }));
    const registerSessionHandoffSpy = vi
      .spyOn(sessionHandoff, 'registerMachineSessionHandoffRpcHandlers')
      .mockImplementation(() => {});
    const rpcHandlerManager = {
      registerHandler: vi.fn(),
    } as any;

    let releaseRepair!: () => void;
    const repairRelease = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    let signalRepairStarted!: () => void;
    const repairStarted = new Promise<void>((resolve) => {
      signalRepairStarted = resolve;
    });
    let repair: ReturnType<
      typeof operationExclusion.withPassiveRepairClaimBarrier
    > | null = null;
    let acquisition: ReturnType<typeof operationExclusion.acquire> | null = null;
    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        } as any,
        deps: { externalSessionOperationExclusion: operationExclusion },
      });

      const externalSessionsInput = registerExternalSessionsSpy.mock.calls[0]?.[0];
      const sessionHandoffInput = registerSessionHandoffSpy.mock.calls[0]?.[0];
      expect(externalSessionsInput?.operationExclusion).toBe(operationExclusion);
      expect(sessionHandoffInput?.sessionOperationExclusion).toBe(
        externalSessionsInput?.operationExclusion,
      );

      repair = externalSessionsInput!.operationExclusion!.withPassiveRepairClaimBarrier({
        sessionId: 'shared-owner-session',
        operationClaimId: 'passive-repair-claim',
      }, async () => {
        signalRepairStarted();
        await repairRelease;
      });
      await repairStarted;
      let acquisitionSettled = false;
      acquisition = sessionHandoffInput!.sessionOperationExclusion!.acquire({
        kind: 'handoff',
        sessionId: 'shared-owner-session',
        requestId: 'handoff-request',
        sourceMachineId: 'source-machine',
        targetMachineId: 'target-machine',
        semanticRequest: 'handoff-semantic-request',
      }).then((result) => {
        acquisitionSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      expect(acquisitionSettled).toBe(false);

      releaseRepair();
      await repair;
      const acquired = await acquisition;
      expect(acquired).toMatchObject({ status: 'acquired' });
      if (acquired.status === 'acquired') {
        await acquired.claim.release();
      }
    } finally {
      releaseRepair();
      await repair?.catch(() => undefined);
      await acquisition?.catch(() => undefined);
      await rm(activeServerDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('normalizes legacy experimentalCodexAcp spawn requests onto canonical codexBackendMode', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      experimentalCodexAcp: true,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.not.objectContaining({
      experimentalCodexAcp: true,
    }));
  });

  it('canonicalizes legacy built-in agent field into backendTarget for fresh spawn requests', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      agent: 'codex',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }));
  });

  it('fails closed for fresh spawn requests with no resolvable backend identity', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    const result = await handler!({
      directory: '/tmp',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Backend target is required for fresh session spawn.',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('fails closed when customAcp is provided through compat or canonical backend-target transport identities', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    const fromLegacyAgent = await handler!({
      directory: '/tmp',
      agent: 'customAcp',
    });
    expect(fromLegacyAgent).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Unknown backend target',
    });

    const fromBuiltInTarget = await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'customAcp', sourceKind: 'built_in' },
    });
    expect(fromBuiltInTarget).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Unknown backend target',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('canonicalizes V1 backendTarget carriers before invoking the spawn handler', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    const fromBuiltInTarget = await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    });
    expect(fromBuiltInTarget).toEqual({ type: 'success', sessionId: 's1' });
    expect(spawnSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
    }));

    const fromConfiguredTarget = await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    });
    expect(fromConfiguredTarget).toEqual({ type: 'success', sessionId: 's1' });
    expect(spawnSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    }));

    const fromBuiltInKey = await handler!({
      directory: '/tmp',
      backendTarget: 'agent:codex',
    });
    expect(fromBuiltInKey).toEqual({ type: 'success', sessionId: 's1' });
    expect(spawnSession).toHaveBeenNthCalledWith(3, expect.objectContaining({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
    }));

    const fromConfiguredKey = await handler!({
      directory: '/tmp',
      backendTarget: 'acpBackend:review-bot',
    });
    expect(fromConfiguredKey).toEqual({ type: 'success', sessionId: 's1' });
    expect(spawnSession).toHaveBeenNthCalledWith(4, expect.objectContaining({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    }));
  });

  it('keeps existing-session resume attach path available without backendTarget', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      sessionId: 'sess_old',
      directory: '/tmp',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_old',
      backendTarget: undefined,
    }));
  });

  it('passes through mcpSelection when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['portable-playwright'],
        forceExcludeServerIds: ['workspace-db'],
      },
    }));
  });

  it('passes through sessionConfigOptionOverrides when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: {
          speed: { updatedAt: 123, value: 'fast' },
        },
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: {
          speed: { updatedAt: 123, value: 'fast' },
        },
      },
    }));
  });

  it('passes canonical transport-backed spawn fields through when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'spawn-nonce-1',
      initialPrompt: 'Summarize the repo',
      agentModeId: 'plan',
      agentModeUpdatedAt: 321,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', profileId: 'work' },
        },
      },
      transcriptStorage: 'direct',
      windowsTerminalWindowName: 'happier-qa',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'spawn-nonce-1',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: { source: 'connected', profileId: 'work' },
        },
      },
      transcriptStorage: 'direct',
      windowsTerminalWindowName: 'happier-qa',
    }));
    const [spawnOptions] = spawnSession.mock.calls[0] ?? [];
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    const firstSpawnCall = spawnSession.mock.calls.at(0) as [unknown] | undefined;
    const forwardedSpawn = firstSpawnCall?.[0] as
      | {
          workspaceId?: string;
          workspaceLocationId?: string;
          workspaceCheckoutId?: string;
        }
      | undefined;
    expect(forwardedSpawn?.workspaceId).toBeUndefined();
    expect(forwardedSpawn?.workspaceLocationId).toBeUndefined();
    expect(forwardedSpawn?.workspaceCheckoutId).toBeUndefined();
  });

  it('generates a recoverable nonce without leaking legacy prompt input into daemon spawn', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    const result = await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      initialPrompt: 'Summarize the repo',
    });

    expect(result).toEqual({ type: 'success', sessionId: 's1' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      spawnNonce: expect.stringMatching(/\S/),
    }));
    const [spawnOptions] = spawnSession.mock.calls[0] ?? [];
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
  });

  it('passes canonical transport-backed spawn fields through when resuming a session and preserves sessionId aliasing', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_options: unknown) => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      sessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'resume-nonce-1',
      profileId: 'profile-work',
      agentModeId: 'plan',
      agentModeUpdatedAt: 654,
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'happy', isolated: true },
      },
      windowsRemoteSessionConsole: 'visible',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', profileId: 'default' },
        },
      },
      transcriptStorage: 'direct',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'resume-nonce-1',
      profileId: 'profile-work',
      terminal: {
        mode: 'tmux',
        tmux: { sessionName: 'happy', isolated: true },
      },
      windowsRemoteSessionConsole: 'visible',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', profileId: 'default' },
        },
      },
      transcriptStorage: 'direct',
    }));
    const [spawnOptions] = spawnSession.mock.calls[0] ?? [];
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    const firstResumeCall = spawnSession.mock.calls.at(0) as [unknown] | undefined;
    const resumedSpawn = firstResumeCall?.[0] as
      | {
          workspaceId?: string;
          workspaceLocationId?: string;
          workspaceCheckoutId?: string;
        }
      | undefined;
    expect(resumedSpawn?.workspaceId).toBeUndefined();
    expect(resumedSpawn?.workspaceLocationId).toBeUndefined();
    expect(resumedSpawn?.workspaceCheckoutId).toBeUndefined();
  });

  it('normalizes legacy experimentalCodexAcp resume requests onto canonical codexBackendMode', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      sessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      experimentalCodexAcp: true,
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.not.objectContaining({
      experimentalCodexAcp: true,
    }));
  });

  it('passes runtimeDescriptorV1 through resume requests and derives codexBackendMode from canonical providerExtra affinity', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      sessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'mcp',
          providerSessionId: 'codex-session-legacy',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              providerSessionId: 'codex-session-1',
            },
          },
        },
      },
    });

    expect(spawnSession).toHaveBeenCalledTimes(1);
    const spawnArgs = (spawnSession.mock.calls as any[][])[0]?.[0];
    expect(spawnArgs).toMatchObject({
      existingSessionId: 'sess_old',
      codexBackendMode: 'appServer',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'mcp',
          providerSessionId: 'codex-session-legacy',
          agentExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              providerSessionId: 'codex-session-1',
            },
          },
        },
      },
    });
  });

  it('passes configured ACP backend backend targets through when resuming a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      type: 'resume-session',
      sessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: ' custom-kiro ',
        configuredBackendId: ' custom-kiro ',
        sourceKind: 'configured',
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'sess_old',
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'custom-kiro',
        configuredBackendId: 'custom-kiro',
        sourceKind: 'configured',
      },
    }));
  });

  it('normalizes invalid permissionMode to undefined when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      permissionMode: 'not-a-mode',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: undefined }));
  });

  it('passes through valid permissionMode values when spawning a session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 's1' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(handler).toBeDefined();

    await handler!({
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      permissionMode: 'yolo',
    });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'yolo' }));
  });

  it('registers bug report diagnostics handlers', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS)).toBe(true);
    expect(registered.has(RPC_METHODS.BUGREPORT_GET_LOG_TAIL)).toBe(true);
    expect(registered.has(RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT)).toBe(true);
  });

  it('registers session log tail handler (machine-scoped)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has(RPC_METHODS.SESSION_LOG_TAIL)).toBe(true);
  });

  it('reads session log tails from paths under happyHomeDir', async () => {
    const root = '/tmp/happier-test-home';
    const logPath = join(root, 'stacks', 'stack-1', 'cli', 'logs', 'session.log');
    await mkdir(join(root, 'stacks', 'stack-1', 'cli', 'logs'), { recursive: true });
    await writeFile(logPath, 'line 1\nline 2\nline 3\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_LOG_TAIL);
    expect(handler).toBeDefined();
    const result = await handler!({ path: logPath, maxBytes: 128 });
    expect(result).toMatchObject({ success: true });
    expect(String((result as any).tail ?? '')).toContain('line 3');
  });

  it('rejects session log tail reads for paths outside happyHomeDir', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rpc-sessionlog-deny-'));
    const outsideLogPath = join(sandbox, 'outside.log');
    await writeFile(outsideLogPath, 'outside log\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_LOG_TAIL);
    expect(handler).toBeDefined();
    const result = await handler!({ path: outsideLogPath, maxBytes: 2048 });
    expect(result).toMatchObject({ success: false });
    expect(String((result as any).error ?? '')).toContain('allowed');
  });

  it('registers daemon terminal handlers (disabled when explicitly configured off)', async () => {
    const prev = process.env.HAPPIER_DAEMON_TERMINAL_ENABLED;
    process.env.HAPPIER_DAEMON_TERMINAL_ENABLED = '0';

    try {
      const registered = new Map<string, (params: any) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const ensure = registered.get((RPC_METHODS as any).DAEMON_TERMINAL_ENSURE);
      const read = registered.get((RPC_METHODS as any).DAEMON_TERMINAL_STREAM_READ);
      const input = registered.get((RPC_METHODS as any).DAEMON_TERMINAL_INPUT);
      const resize = registered.get((RPC_METHODS as any).DAEMON_TERMINAL_RESIZE);
      const close = registered.get((RPC_METHODS as any).DAEMON_TERMINAL_CLOSE);
      const restart = registered.get((RPC_METHODS as any).DAEMON_TERMINAL_RESTART);

      expect(ensure).toBeDefined();
      expect(read).toBeDefined();
      expect(input).toBeDefined();
      expect(resize).toBeDefined();
      expect(close).toBeDefined();
      expect(restart).toBeDefined();

      expect(await ensure!({ terminalKey: 'k', cols: 80, rows: 24 })).toEqual({
        ok: false,
        errorCode: 'terminal_disabled',
        error: 'terminal_disabled',
      });

      expect(await read!({ terminalId: 't1', cursor: 0 })).toEqual({
        ok: false,
        errorCode: 'terminal_disabled',
        error: 'terminal_disabled',
      });
    } finally {
      if (typeof prev === 'string') {
        process.env.HAPPIER_DAEMON_TERMINAL_ENABLED = prev;
      } else {
        delete process.env.HAPPIER_DAEMON_TERMINAL_ENABLED;
      }
    }
  });

  it('registers daemon execution run listing handler', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has((RPC_METHODS as any).DAEMON_EXECUTION_RUNS_LIST)).toBe(true);

    const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await writeExecutionRunMarker({
        pid: 12345,
        happySessionId: 'sess-1',
        runId,
        callId: 'call-1',
        sidechainId: 'side-1',
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        status: 'running',
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });

      const handler = registered.get((RPC_METHODS as any).DAEMON_EXECUTION_RUNS_LIST);
      expect(handler).toBeDefined();

      psListMock.mockResolvedValueOnce([
        { pid: 12345, name: 'node', cmd: '/secret', cpu: 1, memory: 2 },
      ]);

      const res = await handler!({});
      expect(res).toEqual(expect.objectContaining({
        runs: expect.any(Array),
      }));
      expect((res.runs as any[]).some((entry) => entry?.runId === runId)).toBe(true);

      const entry = (res.runs as any[]).find((r) => r?.runId === runId);
      expect(entry?.process?.cmd).toBeUndefined();
    } finally {
      await removeExecutionRunMarker(runId);
    }
  });

  it('continues a session by spawning a new one and storing a Happier replay seed in child metadata', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'one '.repeat(2000) } }),
    );
    const encryptedTwo = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'two' } }),
    );
    const encryptedThree = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'three' } }),
    );

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } },
            { seq: 2, createdAt: 2, content: { t: 'encrypted', c: encryptedTwo } },
            { seq: 3, createdAt: 3, content: { t: 'encrypted', c: encryptedThree } },
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_new',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      directory: '/repo',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 3,
        maxSeedChars: 400,
      },
    });

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo',
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
        approvedNewDirectoryCreation: true,
        existingSessionId: 'sess_new',
      }),
    );
    expect(getSpy).toHaveBeenCalledTimes(2);
    const messageFetchCall = ((getSpy as any).mock.calls as any[]).find((call) => {
      const url = call?.[0];
      return typeof url === 'string' && url.includes(`/v1/sessions/${'sess_prev'}/messages`);
    });
    expect((messageFetchCall?.[1] as any)?.params?.limit).toBe(500);
    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    expect((result as any).seedDraft).toBeUndefined();
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(createdMeta.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_prev', parentCutoffSeqInclusive: 3, strategy: 'replay' });
    expect(createdMeta.forkV1.agentHint).toMatchObject({ agentId: 'acp:review-bot' });
    expect(createdMeta.replaySeedV1).toMatchObject({ v: 1, sourceSessionId: 'sess_prev', sourceCutoffSeqInclusive: 3 });
    expect(createdMeta.flavor).toBe('acp:review-bot');
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('User: three');
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).not.toContain('User: one one one');
  });

  it('propagates auth failures while creating the replay continuation session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } } },
          ],
        },
      } as any);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as any);

    await expect(handler!({
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 1,
      },
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('archives replay-seeded sessions when spawning the continuation fails', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const encryptedTwo = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'two' } }),
    );
    const encryptedThree = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'three' } }),
    );

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { createdAt: 2, content: { t: 'encrypted', c: encryptedTwo } },
            { createdAt: 3, content: { t: 'encrypted', c: encryptedThree } },
          ],
        },
      } as any);

    postSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_new',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: false,
            activeAt: 0,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({ status: 200, data: { success: true, archivedAt: 11 } } as any);

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 2,
        maxSeedChars: 400,
      },
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    });
    expect(postSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/v2/sessions/sess_new/archive'),
      {},
      expect.any(Object),
    );
  });

  it('continues a session with a generous default replay recentMessagesCount when not provided', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const messages = Array.from({ length: 40 }, (_v, i) => {
      const n = i + 1;
      const role = n % 2 === 0 ? 'agent' : 'user';
      const text = role === 'user' ? `u${n}` : `a${n}`;
      const encrypted = encodeBase64(
        encrypt(sessionEncryptionKey, 'dataKey', { role, content: { type: 'text', text } }),
      );
      return { createdAt: n, content: { t: 'encrypted', c: encrypted } };
    });

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 40,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: { messages },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_new',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        maxSeedChars: 10_000,
      },
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('User: u1');
  });

  it('continues a session with an on-demand summary when summary_plus_recent has no cached summary', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    const replaySummaryCalls: Array<{ dialogCount: number; backendId: string }> = [];
    registerMachineRpcHandlers(({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: {
        runReplaySummaryForDialog: async (params: any) => {
          replaySummaryCalls.push({
            dialogCount: params.dialog?.length ?? 0,
            backendId: params.runner?.backendTarget?.kind === 'builtInAgent' ? params.runner.backendTarget.agentId : '',
          });
          return 'ON_DEMAND_SUMMARY';
        },
      },
    }) as any);

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'one' } }),
    );
    const encryptedTwo = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'two' } }),
    );

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = mockAxiosGetSequenceWithSystemRecordMiss([
      {
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      },
      {
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } },
            { seq: 2, createdAt: 2, content: { t: 'encrypted', c: encryptedTwo } },
          ],
        },
      },
    ]);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_new',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
        summaryRunner: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
      },
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    expect(replaySummaryCalls.length).toBe(1);
    expect(replaySummaryCalls[0]).toMatchObject({ backendId: 'claude', dialogCount: 2 });
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('Summary:');
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('ON_DEMAND_SUMMARY');
  });

  it('forks a session with an on-demand summary when no cached summary exists', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const replaySummaryCalls: Array<{ dialogCount: number; backendId: string }> = [];
    registerMachineRpcHandlers(({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: {
        runReplaySummaryForDialog: async (params: any) => {
          replaySummaryCalls.push({
            dialogCount: params.dialog?.length ?? 0,
            backendId: params.runner?.backendTarget?.kind === 'builtInAgent' ? params.runner.backendTarget.agentId : '',
          });
          return 'ON_DEMAND_SUMMARY';
        },
      },
    }) as any);

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = mockAxiosGetSequenceWithSystemRecordMiss([
      // Fetch the parent session record for the fork handler.
      {
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      },
      // Hydrate the starting session.
      {
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      },
      // Hydrate transcript messages.
      {
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } } },
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'two' } } } },
          ],
        },
      },
    ]);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 11,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(replaySummaryCalls.length).toBe(1);
    expect(replaySummaryCalls[0]).toMatchObject({ backendId: 'claude', dialogCount: 2 });
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('Summary:');
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('ON_DEMAND_SUMMARY');
  });

  it('propagates auth failures while loading the parent session for fork', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 401, data: {} } as any);

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('propagates auth failures while resolving fork cutoff', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({ status: 403, data: {} } as any);

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 3 },
      strategy: 'replay',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 403 },
      code: 'not_authenticated',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('propagates auth failures while creating a replay-backed fork session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } } },
          ],
        },
      } as any);
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 401, data: {} } as any);

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
      code: 'not_authenticated',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('propagates provider-native fork auth failures instead of falling back to replay', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    const authError = createAuthenticationHttpStatusError(401, 'OpenCode native fork auth failed');
    evaluateAgentSessionCapabilitySupportMock.mockReturnValue('supported');
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
      deps: {
        awaitAgentSessionOpen: async () => {
          throw authError;
        },
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_parent',
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            path: '/repo',
            flavor: 'opencode',
            opencodeSessionId: 'op_ses_parent',
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
            opencodeServerBaseUrlExplicit: true,
          }),
          metadataVersion: 7,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);
    const archiveSpy = vi.spyOn(axios, 'post');

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    })).rejects.toBe(authError);
    expect(spawnSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('sess_child');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('forks a session by replaying transcript context and storing forkV1/replaySeedV1 in child metadata', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { path: '/repo', flavor: 'claude', permissionMode: { v: 1, mode: 'default', updatedAt: 1 } }),
    );

    const encryptedMessages: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const role = i % 2 === 0 ? 'agent' : 'user';
      const text = i === 1 ? 'first-unique' : `msg-${i}`;
      encryptedMessages.push(
        encodeBase64(
          encrypt(sessionEncryptionKey, 'dataKey', { role, content: { type: 'text', text } }),
        ),
      );
    }

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      // resolve fork cutoff -> fetch single transcript row at seq=20
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            {
              seq: 20,
              createdAt: 20,
              content: { t: 'encrypted', c: encryptedMessages[19] },
            },
          ],
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchSessionById(previousSessionId)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 0,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            ...encryptedMessages.map((ciphertext, idx) => ({
              seq: idx + 1,
              createdAt: idx + 1,
              content: { t: 'encrypted', c: ciphertext },
            })),
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 20 },
      strategy: 'replay',
    });
    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      existingSessionId: 'sess_child',
    }));
    expect(getSpy).toHaveBeenCalled();
    expect(getSpy).toHaveBeenCalledTimes(4);
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(createdMeta.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_parent', parentCutoffSeqInclusive: 20 });
    expect(createdMeta.replaySeedV1).toMatchObject({ v: 1, sourceSessionId: 'sess_parent', sourceCutoffSeqInclusive: 20 });
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('User: first-unique');
  });

  it('forks a configured ACP session by replay while preserving the concrete backend target and configured metadata', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const getSpy = vi.spyOn(axios, 'get');
    const postSpy = vi.spyOn(axios, 'post');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({
              path: '/repo',
              flavor: 'acp:review-bot',
              acpTransportV1: { v: 1, provider: 'acp:review-bot' },
              acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 1,
                backendId: 'review-bot',
                title: 'Review Bot',
              },
            }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({
              path: '/repo',
              flavor: 'acp:review-bot',
              acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 1,
                backendId: 'review-bot',
                title: 'Review Bot',
              },
            }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'msg-1' } } },
            },
            {
              seq: 2,
              createdAt: 2,
              content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'msg-2' } } },
            },
            {
              seq: 3,
              createdAt: 3,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'msg-3' } } },
            },
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'acp:review-bot' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      existingSessionId: 'sess_child',
    }));
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(createdMeta.flavor).toBe('acp:review-bot');
    expect(createdMeta.acpConfiguredBackendV1).toMatchObject({
      v: 1,
      backendId: 'review-bot',
      title: 'Review Bot',
    });
    expect(createdMeta.forkV1).toMatchObject({
      v: 1,
      parentSessionId: 'sess_parent',
      strategy: 'replay',
      agentHint: { agentId: 'acp:review-bot' },
    });
  });

  it('rejects message-level fork requests with an uncommitted seq (<= 0)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const parentMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'claude' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      // fetch parent session record (for fork handler)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain -> fetchSessionById(startingSessionId)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain -> fetchEncryptedTranscriptMessages (beforeSeq=1 yields empty)
      .mockResolvedValueOnce({
        status: 200,
        data: { messages: [] },
      } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 0 },
      strategy: 'replay',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(String((result as any).errorMessage ?? '')).toMatch(/commit|uncommit|seq/i);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not use metadata.summary.text as replay summary fallback for fork replay', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
      deps: {
        runReplaySummaryForDialog: async () => '',
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', {
        path: '/repo',
        flavor: 'claude',
        summary: { text: 'TITLE_ONLY_SUMMARY', updatedAt: 1 },
        permissionMode: { v: 1, mode: 'default', updatedAt: 1 },
      }),
    );

    const encryptedMessages: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const role = i % 2 === 0 ? 'agent' : 'user';
      encryptedMessages.push(
        encodeBase64(
          encrypt(sessionEncryptionKey, 'dataKey', { role, content: { type: 'text', text: `msg-${i}` } }),
        ),
      );
    }

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = mockAxiosGetSequenceWithSystemRecordMiss([
      // Fetch the parent session record for the fork handler.
      {
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      },
      {
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      },
      {
        status: 200,
        data: {
          messages: [
            ...encryptedMessages.map((ciphertext, idx) => ({
              seq: idx + 1,
              createdAt: idx + 1,
              content: { t: 'encrypted', c: ciphertext },
            })),
          ],
        },
      },
    ]);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 11,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).not.toContain('Summary:');
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('Session title: TITLE_ONLY_SUMMARY');
  });

  it('does not use metadata.summary.text as replay summary fallback for continueWithReplay', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', {
        path: '/repo',
        flavor: 'claude',
        summary: { text: 'TITLE_ONLY_SUMMARY', updatedAt: 1 },
      }),
    );

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'one' } }),
    );
    const encryptedTwo = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'two' } }),
    );

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = mockAxiosGetSequenceWithSystemRecordMiss([
      {
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      },
      {
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } },
            { seq: 2, createdAt: 2, content: { t: 'encrypted', c: encryptedTwo } },
          ],
        },
      },
    ]);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_new',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'summary_plus_recent',
        recentMessagesCount: 2,
      },
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).not.toContain('Summary:');
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('Session title: TITLE_ONLY_SUMMARY');
  });

  it('includes session synopsis artifacts in replay seed when replay summary is requested', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const postSpy = vi.spyOn(axios, 'post');
    const getSpy = mockAxiosGetSequenceWithSystemRecordMiss([
      // Fetch the parent session record for the fork handler.
      {
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      },
      // Hydrate the starting session.
      {
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      },
      // Exercise transcript synopsis compatibility after the canonical record lookup misses.
      {
        status: 200,
        data: {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'msg-1' } } },
            },
            {
              seq: 2,
              createdAt: 2,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'text', text: '[memory]' },
                  meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 2, updatedAtMs: 3, synopsis: 'SYNOPSIS_OK' } } },
                },
              },
            },
            {
              seq: 3,
              createdAt: 3,
              content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'msg-2' } } },
            },
          ],
        },
      },
    ]);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 11,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      replaySummaryRunner: {
        v: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'default',
        permissionMode: 'no_tools',
      },
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('Summary:');
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('SYNOPSIS_OK');
  });

  it('does not include session synopsis artifacts in replay seed when replay summary is not requested', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const getSpy = vi.spyOn(axios, 'get');
    const postSpy = vi.spyOn(axios, 'post');
    getSpy
      // fetch parent session record (for fork handler)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain -> fetchSessionById(startingSessionId)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'msg-1' } } },
            },
            {
              seq: 2,
              createdAt: 2,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'text', text: '[memory]' },
                  meta: { happier: { kind: 'session_synopsis.v1', payload: { v: 1, seqTo: 2, updatedAtMs: 3, synopsis: 'SYNOPSIS_OK' } } },
                },
              },
            },
            {
              seq: 3,
              createdAt: 3,
              content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'msg-2' } } },
            },
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 11,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).not.toContain('Summary:');
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).not.toContain('SYNOPSIS_OK');
  });

  it('forks latest session via ACP session/fork when supported and parent metadata indicates ACP transport (no replay seed)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', {
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'codex_parent',
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: { backendMode: 'acp', providerSessionId: 'codex_parent' },
        },
        acpSessionModelsV1: {
          v: 1,
          agentId: 'codex',
          updatedAt: 1,
          currentModelId: 'model-1',
          availableModels: [{ id: 'model-1', name: 'Model 1' }],
        },
        permissionMode: { v: 1, mode: 'default', updatedAt: 1 },
      }),
    );

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      // fetch parent session record
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 10,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      // fetch child session record for metadata update
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            metadata: parentMetadataCiphertext,
            metadataVersion: 3,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any);

    const fork = vi.fn(async () => ({
      providerSessionId: 'codex_forked',
      launch: {
        sessionStateUpdates: [{
          fieldId: 'identity.runtimeDescriptor' as const,
          value: buildCodexAgentRuntimeDescriptor({
            backendMode: 'acp',
            providerSessionId: 'codex_forked',
          }),
        }],
      },
    }));
    resolveExecutionSurfacesMock.mockResolvedValueOnce(emptyExecutionSurfaces({
      fork: { fork },
    }));

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(resolveExecutionSurfacesMock).toHaveBeenCalledWith('codex');
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    }));

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        approvedNewDirectoryCreation: true,
        resume: 'codex_forked',
        codexBackendMode: 'acp',
      }),
    );

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'codex' });
    expect(updated.runtimeDescriptorV1).toMatchObject({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'acp', providerSessionId: 'codex_forked' },
    });
    expect(updated.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_parent', strategy: 'acp_fork_latest' });
    expect(updated.forkV1.agentHint).toMatchObject({ agentId: 'codex', backendMode: 'acp', providerSessionId: 'codex_forked' });
    expect(updated.replaySeedV1).toBeUndefined();
  });

  it('propagates ACP child session fetch auth failures instead of returning a generic fork error', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', {
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'codex_parent',
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: { backendMode: 'acp', providerSessionId: 'codex_parent' },
        },
      }),
    );

    const authError = createAuthenticationHttpStatusError(403, 'ACP child fetch auth failed');
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 10,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockRejectedValueOnce(authError);

    mockForkSurfaceOnce(async () => ({
      providerSessionId: 'codex_forked',
      launch: {},
    }));
    const archiveSpy = vi.spyOn(axios, 'post');

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'acp_fork_latest',
    })).rejects.toBe(authError);

    expect(getSpy.mock.calls.some(([url]) => String(url).includes('/sessions/sess_child'))).toBe(true);
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('sess_child');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('propagates ACP child metadata update auth failures instead of returning a generic fork error', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_parent',
      opencodeBackendMode: 'acp',
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });
    const authError = Object.assign(new Error('invalid token'), {
      data: {
        statusCode: 401,
        error: 'invalid-token',
      },
    });

    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 4,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    mockForkSurfaceOnce(async () => ({
      providerSessionId: 'op_forked',
      launch: {},
    }));
    updateSessionMetadataWithRetryMock.mockRejectedValueOnce(authError);
    const archiveSpy = vi.spyOn(axios, 'post');

    await expect(
      handler!({
        v: 1,
        parentSessionId: 'sess_parent',
        forkPoint: { type: 'latest' },
        strategy: 'acp_fork_latest',
      }),
    ).rejects.toBe(authError);

    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('sess_child');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('propagates ACP fork auth failures instead of falling back to replay', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_replay_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_parent',
          seq: 2,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            path: '/repo',
            flavor: 'opencode',
            opencodeSessionId: 'op_parent',
            opencodeBackendMode: 'acp',
          }),
          metadataVersion: 7,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const authError = createAuthenticationHttpStatusError(401, 'ACP load auth failed');
    mockForkSurfaceOnce(async () => {
      throw authError;
    });
    const archiveSpy = vi.spyOn(axios, 'post');

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'acp_fork_latest',
    })).rejects.toBe(authError);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('forks latest configured ACP sessions through the configured backend runtime and preserves configured backend identity', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({
        acpCatalogSettingsV1: {
          v: 2,
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              command: 'review-cli',
              args: ['acp'],
              env: {},
              transportProfile: 'generic',
              capabilities: {
                supportsLoadSession: true,
                supportsModes: 'unknown',
                supportsModels: 'unknown',
                supportsConfigOptions: 'unknown',
                promptImageSupport: 'unknown',
              },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        },
      }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
    });

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 8,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({
              path: '/repo',
              flavor: 'acp:review-bot',
              acpTransportV1: { v: 1, provider: 'acp:review-bot' },
              acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 1,
                backendId: 'review-bot',
                title: 'Review Bot',
              },
              agentRuntimeDescriptorV1: {
                v: 1,
                agentId: 'acp:review-bot',
                provider: {
                  providerSessionId: 'review_parent',
                },
              },
            }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'acp:review-bot' }),
            metadataVersion: 3,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    const fork = mockForkSurfaceOnce(async () => ({
      providerSessionId: 'review_forked',
      launch: {
        sessionStateUpdates: [{
          fieldId: 'identity.providerSessionId' as const,
          value: 'review_forked',
        }],
      },
    }));

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      approvedNewDirectoryCreation: true,
      resume: 'review_forked',
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'acp:review-bot' });
    expect(updated.acpConfiguredBackendV1).toMatchObject({
      v: 1,
      backendId: 'review-bot',
      title: 'Review Bot',
    });
    expect(updated.forkV1).toMatchObject({
      v: 1,
      parentSessionId: 'sess_parent',
      strategy: 'acp_fork_latest',
      agentHint: { agentId: 'acp:review-bot', providerSessionId: 'review_forked' },
    });
    expect(updated.replaySeedV1).toBeUndefined();
  });

  it('shapes OpenCode ACP fork continuation through provider metadata when latest fork uses ACP session/fork', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_parent',
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 1,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [{ id: 'openai/gpt-5.2', name: 'GPT-5.2' }],
      },
    });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 4,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'opencode' }),
            metadataVersion: 3,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    const fork = mockForkSurfaceOnce(async () => ({
      providerSessionId: 'op_forked',
      launch: {
        environmentVariables: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
          HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        },
        sessionStateUpdates: [
          {
            fieldId: 'identity.runtimeDescriptor' as const,
            value: buildOpenCodeAgentRuntimeDescriptor({
              backendMode: 'acp',
              providerSessionId: 'op_forked',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            }),
          },
          {
            fieldId: 'identity.providerSessionId' as const,
            value: 'op_forked',
          },
        ],
      },
    }));

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(fork).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        approvedNewDirectoryCreation: true,
        resume: 'op_forked',
        environmentVariables: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
          HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'opencode' });
    expect(updated.opencodeSessionId).toBe('op_forked');
    expect(updated.runtimeDescriptorV1).toMatchObject({
      agentId: 'opencode',
      agent: {
        backendMode: 'acp',
        providerSessionId: 'op_forked',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
    });
    expect(updated.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_parent', strategy: 'acp_fork_latest' });
    expect(updated.forkV1.agentHint).toMatchObject({ agentId: 'opencode', backendMode: 'acp', providerSessionId: 'op_forked' });
    expect(updated.replaySeedV1).toBeUndefined();
  });

  it('uses canonical Codex ACP runtime metadata for latest-fork eligibility', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(9);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(3);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(4),
    });
    const parentMetadataCiphertext = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', {
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'codex_parent',
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: { backendMode: 'acp', providerSessionId: 'codex_parent' },
        },
      }),
    );

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 4,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: parentMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            metadata: encodeBase64(encrypt(sessionEncryptionKey, 'dataKey', { path: '/repo', flavor: 'codex' })),
            metadataVersion: 3,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any);

    const fork = mockForkSurfaceOnce(async () => ({
      providerSessionId: 'codex_forked',
      launch: {
        sessionStateUpdates: [
          {
            fieldId: 'identity.runtimeDescriptor' as const,
            value: buildCodexAgentRuntimeDescriptor({
              backendMode: 'acp',
              providerSessionId: 'codex_forked',
            }),
          },
          {
            fieldId: 'identity.providerSessionId' as const,
            value: 'codex_forked',
          },
        ],
      },
    }));

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(fork).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        approvedNewDirectoryCreation: true,
        resume: 'codex_forked',
        codexBackendMode: 'acp',
      }),
    );

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'codex' });
    expect(updated.runtimeDescriptorV1).toMatchObject({
      agentId: 'codex',
      agent: { backendMode: 'acp', providerSessionId: 'codex_forked' },
    });
    expect(updated.forkV1).toMatchObject({ v: 1, parentSessionId: 'sess_parent', strategy: 'acp_fork_latest' });
    expect(updated.forkV1.agentHint).toMatchObject({ agentId: 'codex', backendMode: 'acp', providerSessionId: 'codex_forked' });
    expect(updated.replaySeedV1).toBeUndefined();
  });

  it('falls back to replay fork when parent metadata does not indicate ACP transport (even if provider has a vendor session id)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const getSpy = vi.spyOn(axios, 'get');
    const postSpy = vi.spyOn(axios, 'post');

    getSpy
      // fetch parent session record
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'codex', codexSessionId: 'codex_parent' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain -> fetchSessionById(startingSessionId)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/repo', flavor: 'codex', codexSessionId: 'codex_parent' }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'msg-1' } } },
            },
            {
              seq: 2,
              createdAt: 2,
              content: {
                t: 'plain',
                v: {
                  role: 'agent',
                  content: { type: 'text', text: 'msg-2' },
                  meta: {
                    happierMedia: {
                      kind: 'session_media.v1',
                      payload: {
                        media: [{
                          id: 'media-1',
                          role: 'output',
                          category: 'generated',
                          mediaKind: 'image',
                          mimeType: 'image/png',
                          name: 'fork-image.png',
                          path: '.happier/uploads/generated/sess_parent/msg-2/fork-image.png',
                          sizeBytes: 12,
                          origin: { source: 'provider-generated' },
                        }],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 11,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'codex' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(resolveExecutionSurfacesMock).toHaveBeenCalledWith('codex');
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(String(createdMeta.replaySeedV1?.seedText ?? '')).toContain('msg-1');
    expect(createdMeta.sessionMediaContinuityV1).toMatchObject({
      v: 1,
      sourceSessionId: 'sess_parent',
      sourceCutoffSeqInclusive: 3,
      referencedWorkspacePaths: ['.happier/uploads/generated/sess_parent/msg-2/fork-image.png'],
    });
  });

  it('includes fork-chain ancestor transcript in replaySeedV1 when forking a forked session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_grandchild' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const rootKey = new Uint8Array(32).fill(5);
    const childKey = new Uint8Array(32).fill(6);
    const rootEnvelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: rootKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });
    const childEnvelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: childKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(8),
    });

    const rootMetadataCiphertext = encodeBase64(
      encrypt(rootKey, 'dataKey', { path: '/repo', flavor: 'claude' }),
    );
    const childMetadataCiphertext = encodeBase64(
      encrypt(childKey, 'dataKey', {
        path: '/repo',
        flavor: 'claude',
        forkV1: { v: 1, parentSessionId: 'sess_root', parentCutoffSeqInclusive: 3, createdAtMs: 1, strategy: 'replay' },
      }),
    );

    const encryptedRootMessages = [
      encodeBase64(encrypt(rootKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'root-unique' } })),
      encodeBase64(encrypt(rootKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'root-two' } })),
      encodeBase64(encrypt(rootKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'root-three' } })),
    ];
    const encryptedChildMessages = [
      encodeBase64(encrypt(childKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'child-one' } })),
      encodeBase64(encrypt(childKey, 'dataKey', { role: 'agent', content: { type: 'text', text: 'child-two' } })),
    ];

	    const getSpy = vi.spyOn(axios, 'get');
	    const postSpy = vi.spyOn(axios, 'post');
	    getSpy
	      // fetch parent session record (fork handler)
	      .mockResolvedValueOnce({
	        status: 200,
	        data: {
	          session: {
	            id: 'sess_child',
	            seq: 2,
	            createdAt: 10,
	            updatedAt: 11,
	            active: true,
	            activeAt: 11,
	            metadata: childMetadataCiphertext,
	            metadataVersion: 7,
	            agentState: null,
	            agentStateVersion: 0,
	            dataEncryptionKey: encodeBase64(childEnvelope),
	          },
	        },
	      } as any)
	      // resolveForkCutoffSeqInclusive -> fetchEncryptedTranscriptMessages (target row)
	      .mockResolvedValueOnce({
	        status: 200,
	        data: {
	          messages: [{ seq: 2, createdAt: 21, content: { t: 'encrypted', c: encryptedChildMessages[1] } }],
	        },
	      } as any)
	      // hydrate fork chain: fetch child session record
	      .mockResolvedValueOnce({
	        status: 200,
	        data: {
	          session: {
            id: 'sess_child',
            seq: 2,
            createdAt: 10,
            updatedAt: 11,
            active: true,
            activeAt: 11,
            metadata: childMetadataCiphertext,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(childEnvelope),
          },
        },
      } as any)
      // hydrate fork chain: fetch root session record
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_root',
            seq: 3,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: rootMetadataCiphertext,
            metadataVersion: 3,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(rootEnvelope),
          },
        },
      } as any)
      // hydrateReplayDialogFromForkChain(child) -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: encryptedChildMessages.map((ciphertext, idx) => ({
            seq: idx + 1,
            createdAt: 20 + idx,
            content: { t: 'encrypted', c: ciphertext },
          })),
        },
      } as any)
      // hydrateReplayDialogFromForkChain(root) -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: encryptedRootMessages.map((ciphertext, idx) => ({
            seq: idx + 1,
            createdAt: idx + 1,
            content: { t: 'encrypted', c: ciphertext },
          })),
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_grandchild',
          seq: 0,
          createdAt: 100,
          updatedAt: 100,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    updateSessionMetadataWithRetryMock.mockClear();

	    const result = await handler!({
	      v: 1,
	      parentSessionId: 'sess_child',
	      forkPoint: { type: 'seq', upToSeqInclusive: 2 },
	      strategy: 'replay',
	    });
	    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_grandchild' });

	    // Ensure the fork-chain hydration actually read both segments (root + child).
	    const getUrls = getSpy.mock.calls.map((call) => String(call?.[0] ?? ''));
	    expect(getUrls.join('\n')).toContain('/v2/sessions/sess_root');
	    expect(getUrls.join('\n')).toContain('/v1/sessions/sess_root/messages');
	    expect(getUrls.join('\n')).toContain('/v1/sessions/sess_child/messages');

	    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(0);
	    expect(postSpy).toHaveBeenCalledTimes(1);
	    const posted = (postSpy as any).mock.calls[0][1] as any;
	    const createdMeta = JSON.parse(String(posted.metadata)) as any;
	    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('User: root-unique');
    expect(String(createdMeta.replaySeedV1.seedText ?? '')).toContain('User: child-one');
  });

  it('forks an OpenCode session via provider-native server fork when backendMode is server', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const fork = mockForkSurfaceOnce(async () => createOpenCodeForkResult({
      providerSessionId: 'op_ses_forked',
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    }));

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      forkPoint: { kind: 'latest' },
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: expect.objectContaining({ backendId: 'opencode' }),
      resume: 'op_ses_forked',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'opencode' });
    expect(updated.opencodeSessionId).toBe('op_ses_forked');
    expect(updated.runtimeDescriptorV1).toMatchObject({
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'op_ses_forked',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
    });
    expect(updated.forkV1).toMatchObject({
      v: 1,
      parentSessionId: 'sess_parent',
      parentCutoffSeqInclusive: 5,
      strategy: 'provider_native',
      agentHint: { agentId: 'opencode', backendMode: 'server', providerSessionId: 'op_ses_forked' },
    });
  });

  it('propagates provider-native child session fetch auth failures instead of returning a generic fork error', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
      deps: {
        awaitAgentSessionOpen: async () => ({
          status: 'opened',
          request: {
            kind: 'fork',
            sessionId: 'sess_child',
            cwd: '/repo',
            source: {
              sessionId: 'sess_parent',
              providerSessionId: 'op_ses_parent',
              cwd: '/repo',
            },
          },
        }),
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    mockForkSurfaceOnce(async () => createOpenCodeForkResult({
      providerSessionId: 'op_ses_forked',
      backendMode: 'server',
    }));

    const authError = createAuthenticationHttpStatusError(401, 'Provider-native child fetch auth failed');
    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: JSON.stringify({
              path: '/repo',
              flavor: 'opencode',
              opencodeSessionId: 'op_ses_parent',
              opencodeBackendMode: 'server',
            }),
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockRejectedValueOnce(authError);
    const archiveSpy = vi.spyOn(axios, 'post');

    await expect(handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    })).rejects.toBe(authError);

    expect(getSpy.mock.calls.some(([url]) => String(url).includes('/sessions/sess_child'))).toBe(true);
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('sess_child');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('propagates provider-native child metadata update auth failures instead of returning a generic fork error', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
      deps: {
        awaitAgentSessionOpen: async () => ({
          status: 'opened',
          request: {
            kind: 'fork',
            sessionId: 'sess_child',
            cwd: '/repo',
            source: {
              sessionId: 'sess_parent',
              providerSessionId: 'op_ses_parent',
              cwd: '/repo',
            },
          },
        }),
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    mockForkSurfaceOnce(async () => createOpenCodeForkResult({
      providerSessionId: 'op_ses_forked',
      backendMode: 'server',
    }));

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'server',
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });
    const authError = Object.assign(new Error('invalid token'), {
      data: {
        statusCode: 401,
        error: 'invalid-token',
      },
    });

    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);
    updateSessionMetadataWithRetryMock.mockRejectedValueOnce(authError);
    const archiveSpy = vi.spyOn(axios, 'post');

    await expect(
      handler!({
        v: 1,
        parentSessionId: 'sess_parent',
        forkPoint: { type: 'latest' },
        strategy: 'provider_native',
      }),
    ).rejects.toBe(authError);

    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('sess_child');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('forks a Codex app-server session via provider-native conversation fork', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const fork = mockForkSurfaceOnce(async () => createCodexForkResult({
      providerSessionId: 'codex-thread-forked',
      backendMode: 'appServer',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceGroupId: 'happier',
      connectedServiceProfileId: 'codex1',
      homePath: '/tmp/codex-home',
    }));

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'codex-thread-parent',
      codexBackendMode: 'appServer',
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        providerSessionId: 'codex-thread-parent',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'happier',
        connectedServiceProfileId: 'codex1',
        homePath: '/tmp/codex-home',
      }),
      permissionMode: 'acceptEdits',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-5.4' },
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'codex' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      resume: 'codex-thread-forked',
      codexBackendMode: 'appServer',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex1',
          },
        },
      },
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'codex' });
    expect(updated.codexSessionId).toBe('codex-thread-forked');
    expect(updated.runtimeDescriptorV1).toMatchObject({
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'codex-thread-forked',
      },
    });
    expect(updated.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'happier',
          profileId: 'codex1',
        },
      },
    });
    expect(updated.forkV1).toMatchObject({
      v: 1,
      parentSessionId: 'sess_parent',
      parentCutoffSeqInclusive: 5,
      strategy: 'provider_native',
      agentHint: { agentId: 'codex', backendMode: 'appServer', providerSessionId: 'codex-thread-forked' },
    });
    expect(updated.replaySeedV1).toBeUndefined();
  });

  it('accepts legacy codex flavor aliases when resolving provider-native fork support', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const fork = mockForkSurfaceOnce(async () => createCodexForkResult({
      providerSessionId: 'codex-thread-forked',
      backendMode: 'appServer',
    }));

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'openai',
      codexSessionId: 'codex-thread-parent',
      codexBackendMode: 'appServer',
      sessionModelsV1: { v: 1, provider: 'codex', updatedAt: 1, currentModelId: 'gpt-5.4', availableModels: [] },
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'codex' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      resume: 'codex-thread-forked',
      codexBackendMode: 'appServer',
    }));
  });

  it('fails when provider-native fork cannot load the child session metadata after spawning', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    const stopSession = vi.fn(async () => true);
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    mockForkSurfaceOnce(async () => createCodexForkResult({
      providerSessionId: 'codex-thread-forked',
      backendMode: 'appServer',
    }));

    const getSpy = vi.spyOn(axios, 'get');
    getSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_parent',
          seq: 5,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            path: '/repo',
            flavor: 'codex',
            codexSessionId: 'codex-thread-parent',
            codexBackendMode: 'appServer',
          }),
          metadataVersion: 7,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);
    getSpy.mockRejectedValue(new Error('child session fetch failed'));

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'UNEXPECTED',
      errorMessage: 'child session fetch failed',
    });
    expect(stopSession).toHaveBeenCalledWith('sess_child');
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('fails closed when session metadata does not identify a provider', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 'sess_child' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_parent',
          seq: 5,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo' }),
          metadataVersion: 7,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'Session metadata missing agent flavor',
    });
  });

  it('returns the actual spawn error when explicit provider-native fork support exists but spawning fails', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async () => ({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      errorMessage: 'daemon unavailable',
    } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    mockForkSurfaceOnce(async () => createCodexForkResult({
      providerSessionId: 'codex-thread-forked',
      backendMode: 'appServer',
    }));

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_parent',
          seq: 5,
          createdAt: 1,
          updatedAt: 2,
          active: true,
          activeAt: 2,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            path: '/repo',
            flavor: 'codex',
            codexSessionId: 'codex-thread-parent',
            codexBackendMode: 'appServer',
          }),
          metadataVersion: 7,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      errorMessage: 'daemon unavailable',
    });
  });

  it('uses provider-native OpenCode fork for message-level forks while preserving branch-and-edit semantics for user messages', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const fork = mockForkSurfaceOnce(async () => createOpenCodeForkResult({
      providerSessionId: 'op_ses_forked',
      backendMode: 'server',
    }));

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'server',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      acpSessionModesV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 462,
        configOptions: [
          {
            id: 'approval',
            name: 'Approval',
            type: 'string',
            currentValue: 'never',
          },
        ],
      },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      // fetch parent session record (fork handler)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // resolve fork cutoff -> fetch single transcript row at seq=3 (user message)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            {
              seq: 3,
              createdAt: 3,
              localId: 'local-3',
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'USER_BRANCH_EDIT' } } },
            },
          ],
        },
      } as any)
      // fetch child session record (metadata patch)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 3 },
      strategy: 'auto',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });

    // The canonical provider surface receives the clicked message sequence.
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'sess_parent',
      forkPoint: { kind: 'message_seq', upToSeqInclusive: 3 },
    }));

    // Stored fork lineage uses an exclusive cutoff when the fork target is a user message.
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'opencode' });
    expect(updated.forkV1).toMatchObject({ parentCutoffSeqInclusive: 2, strategy: 'provider_native' });
    expect(updated.replaySeedV1).toBeUndefined();
  });

  it('does not apply branch-and-edit exclusive cutoff when forking from the first user message', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    mockForkSurfaceOnce(async () => createOpenCodeForkResult({
      providerSessionId: 'op_ses_forked',
      backendMode: 'server',
    }));

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'server',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      acpSessionModesV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 462,
        configOptions: [
          {
            id: 'approval',
            name: 'Approval',
            type: 'string',
            currentValue: 'never',
          },
        ],
      },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });

    const getSpy = vi.spyOn(axios, 'get');
    getSpy
      // fetch parent session record (fork handler)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 5,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // resolve fork cutoff -> fetch single transcript row at seq=1 (user message)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            {
              seq: 1,
              createdAt: 1,
              localId: 'local-1',
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'FIRST_USER' } } },
            },
          ],
        },
      } as any)
      // fetch child session record (metadata patch)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_child',
            seq: 0,
            createdAt: 10,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            encryptionMode: 'plain',
            metadata: childMetadataPlain,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 1 },
      strategy: 'auto',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelSelection: {
        v: 1,
        updatedAt: 456,
        ref: {
          agentTargetKey: 'backend:opencode',
          providerConnectionId: null,
          modelId: 'gpt-test',
        },
      },
    }));

    // The first user message should not be treated as a "branch-and-edit" fork point.
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updater = (updateSessionMetadataWithRetryMock as any).mock.calls[0][0].updater as (m: any) => any;
    const updated = updater({ path: '/repo', flavor: 'opencode' });
    expect(updated.forkV1).toMatchObject({ parentCutoffSeqInclusive: 1, strategy: 'provider_native' });
    expect(updated.permissionMode).toBe('yolo');
    expect(updated.permissionModeUpdatedAt).toBe(123);
    expect(updated.modelSelectionIntentV1).toEqual({
      v: 1,
      updatedAt: 456,
      selection: {
        agentTargetKey: 'backend:opencode',
        providerConnectionId: null,
        modelId: 'gpt-test',
      },
    });
    expect(updated.modelOverrideV1).toEqual({ v: 1, updatedAt: 456, modelId: 'gpt-test' });
    expect(updated.acpSessionModesV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 460,
      currentModeId: 'build',
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' },
      ],
    });
    expect(updated.acpSessionModelsV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 461,
      currentModelId: 'openai/gpt-5.2',
      availableModels: [
        { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
      ],
    });
    expect(updated.acpConfigOptionsV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 462,
      configOptions: [
        {
          id: 'approval',
          name: 'Approval',
          type: 'string',
          currentValue: 'never',
        },
      ],
    });
    expect(updated.acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 457, modeId: 'plan' });
    expect(updated.acpConfigOptionOverridesV1).toEqual({
      v: 1,
      updatedAt: 458,
      overrides: {
        sandbox: { updatedAt: 458, value: 'workspace-write' },
      },
    });
  });

  it('preserves OpenCode backend mode when replay-forking an ACP-backed OpenCode session', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();
    mockReplayChildLaunchSurfaceOnce(async () => ({
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    }));

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
      acpSessionModesV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 460,
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      acpSessionModelsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 461,
        currentModelId: 'openai/gpt-5.2',
        availableModels: [
          { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
        ],
      },
      acpConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 462,
        configOptions: [
          {
            id: 'approval',
            name: 'Approval',
            type: 'string',
            currentValue: 'never',
          },
        ],
      },
      acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
      acpConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 458,
        overrides: {
          sandbox: { updatedAt: 458, value: 'workspace-write' },
        },
      },
    });
    const childMetadataPlain = JSON.stringify({ path: '/repo', flavor: 'opencode' });

	    const getSpy = vi.spyOn(axios, 'get');
	    const postSpy = vi.spyOn(axios, 'post');
	    getSpy
	      // fetch parent session record (for fork handler)
	      .mockResolvedValueOnce({
	        status: 200,
	        data: {
	          session: {
	            id: 'sess_parent',
	            seq: 2,
	            createdAt: 1,
	            updatedAt: 2,
	            active: true,
	            activeAt: 2,
	            encryptionMode: 'plain',
	            metadata: parentMetadataPlain,
	            metadataVersion: 7,
	            agentState: null,
	            agentStateVersion: 0,
	            dataEncryptionKey: null,
	          },
	        },
	      } as any)
	      // resolveForkCutoffSeqInclusive -> fetchEncryptedTranscriptMessages (target row)
	      .mockResolvedValueOnce({
	        status: 200,
	        data: {
	          messages: [
	            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'hi fork' } } } },
	          ],
	        },
	      } as any)
	      // hydrateReplayDialogFromTranscript -> fetchSessionById(previousSessionId)
	      .mockResolvedValueOnce({
	        status: 200,
	        data: {
	          session: {
            id: 'sess_parent',
            seq: 2,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      // hydrateReplayDialogFromTranscript -> fetchEncryptedTranscriptMessages
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello fork' } } } },
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'hi fork' } } } },
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'opencode' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'seq', upToSeqInclusive: 2 },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      existingSessionId: 'sess_child',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelSelection: {
        v: 1,
        updatedAt: 456,
        ref: {
          agentTargetKey: 'backend:opencode',
          providerConnectionId: null,
          modelId: 'gpt-test',
        },
      },
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(0);
    expect(postSpy).toHaveBeenCalledTimes(1);
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(createdMeta.opencodeBackendMode).toBeUndefined();
    expect(createdMeta.opencodeServerBaseUrl).toBeUndefined();
    expect(createdMeta.opencodeServerBaseUrlExplicit).toBeUndefined();
    expect(createdMeta.permissionMode).toBe('yolo');
    expect(createdMeta.permissionModeUpdatedAt).toBe(123);
    expect(createdMeta.modelSelectionIntentV1).toEqual({
      v: 1,
      updatedAt: 456,
      selection: {
        agentTargetKey: 'backend:opencode',
        providerConnectionId: null,
        modelId: 'gpt-test',
      },
    });
    expect(createdMeta.modelOverrideV1).toEqual({ v: 1, updatedAt: 456, modelId: 'gpt-test' });
    expect(createdMeta.acpSessionModesV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 460,
      currentModeId: 'build',
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' },
      ],
    });
    expect(createdMeta.acpSessionModelsV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 461,
      currentModelId: 'openai/gpt-5.2',
      availableModels: [
        { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
      ],
    });
    expect(createdMeta.acpConfigOptionsV1).toEqual({
      v: 1,
      agentId: 'opencode',
      updatedAt: 462,
      configOptions: [
        {
          id: 'approval',
          name: 'Approval',
          type: 'string',
          currentValue: 'never',
        },
      ],
    });
    expect(createdMeta.acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 457, modeId: 'plan' });
    expect(createdMeta.acpConfigOptionOverridesV1).toEqual({
      v: 1,
      updatedAt: 458,
      overrides: {
        sandbox: { updatedAt: 458, value: 'workspace-write' },
      },
    });
  });

  it('does not inherit non-explicit OpenCode server affinity during replay forks', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_child' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get((RPC_METHODS as any).SESSION_FORK);
    expect(handler).toBeDefined();
    mockReplayChildLaunchSurfaceOnce(async () => ({
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
      },
    }));

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    });

    const parentMetadataPlain = JSON.stringify({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'op_ses_parent',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
    });

    const getSpy = vi.spyOn(axios, 'get');
    const postSpy = vi.spyOn(axios, 'post');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_parent',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            encryptionMode: 'plain',
            metadata: parentMetadataPlain,
            metadataVersion: 7,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [
            { seq: 1, createdAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello fork' } } } },
          ],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_child',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'opencode' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    const result = await handler!({
      v: 1,
      parentSessionId: 'sess_parent',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });

    expect(result).toMatchObject({ ok: true, childSessionId: 'sess_child' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      existingSessionId: 'sess_child',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
      },
    }));
    const posted = (postSpy as any).mock.calls[0][1] as any;
    const createdMeta = JSON.parse(String(posted.metadata)) as any;
    expect(createdMeta.opencodeBackendMode).toBeUndefined();
    expect(createdMeta.opencodeServerBaseUrl).toBeUndefined();
    expect(createdMeta.opencodeServerBaseUrlExplicit).toBeUndefined();
  });

  it('rejects unknown replay agent ids (fail closed)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const getSpy = vi.spyOn(axios, 'get').mockImplementation(() => {
      throw new Error('should not call axios.get for unknown agent ids');
    });

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const result = await handler!({
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'not-a-real-agent' },
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 2,
        seedMode: 'draft',
      },
    });

    expect(spawnSession).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'error' });
  });

  it('does not inject replay seeds as initial prompts (seed is stored in metadata)', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const spawnSession = vi.fn(async (_opts: any) => ({ type: 'success', sessionId: 'sess_new' } as const));
    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const handler = registered.get(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY);
    expect(handler).toBeDefined();

    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-1',
      encryption: { type: 'dataKey', machineKey, publicKey },
    });

    const sessionEncryptionKey = new Uint8Array(32).fill(5);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionEncryptionKey,
      recipientPublicKey: publicKey,
      randomBytes: (length: number) => new Uint8Array(length).fill(7),
    });

    const encryptedOne = encodeBase64(
      encrypt(sessionEncryptionKey, 'dataKey', { role: 'user', content: { type: 'text', text: 'hello' } }),
    );

    const getSpy = vi.spyOn(axios, 'get');
    const postSpy = vi.spyOn(axios, 'post');
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        data: {
          session: {
            id: 'sess_prev',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: encodeBase64(envelope),
          },
        },
      } as any)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          messages: [{ seq: 1, createdAt: 1, content: { t: 'encrypted', c: encryptedOne } }],
        },
      } as any);

    postSpy.mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess_new',
          seq: 0,
          createdAt: 10,
          updatedAt: 10,
          active: false,
          activeAt: 0,
          encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as any);

    updateSessionMetadataWithRetryMock.mockClear();

    const result = await handler!({
      directory: '/repo',
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId: 'sess_prev',
        strategy: 'recent_messages',
        recentMessagesCount: 1,
        seedMode: 'daemon_initial_prompt',
      },
    });

    expect(spawnSession).toHaveBeenCalledTimes(1);
    // vitest's Mock type can infer a 0-arg function; use a narrow cast for call inspection.
    const arg = ((spawnSession as any).mock?.calls?.[0] as any[] | undefined)?.[0] ?? null;
    expect(arg && typeof arg === 'object' && 'initialPrompt' in arg).toBe(false);
    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_new' });
    expect((result as any).seedDraft).toBeUndefined();
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(0);
  });

  it('includes stack diagnostics context for bug report collection when stack env is set', async () => {
    const stackHome = await mkdtemp(join(tmpdir(), 'rpc-bugreport-stack-'));
    const stackName = 'qa-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'dev.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimePath,
      JSON.stringify({
        stackName,
        logs: {
          runner: runnerLogPath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(runnerLogPath, 'runner output\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimePath;

    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const collectHandler = registered.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
      expect(collectHandler).toBeDefined();
      const diagnostics = await collectHandler!({});
      expect(diagnostics.stackContext?.stackName).toBe(stackName);
      expect(diagnostics.stackContext?.runtimeStatePath).toBe(runtimePath);
      expect(diagnostics.stackContext?.logCandidates).toContain(runnerLogPath);
      expect(diagnostics.doctorSnapshot).toBeDefined();
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('rejects bug report log tail reads for paths outside diagnostics candidates', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'rpc-bugreport-deny-'));
    const outsideLogPath = join(sandbox, 'outside.log');
    await writeFile(outsideLogPath, 'outside log\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    const logTailHandler = registered.get(RPC_METHODS.BUGREPORT_GET_LOG_TAIL);
    expect(logTailHandler).toBeDefined();
    const result = await logTailHandler!({
      path: outsideLogPath,
      maxBytes: 2048,
    });

    expect(result).toMatchObject({
      ok: false,
    });
    expect(String(result.error ?? '')).toContain('not allowed');
  });

  it('bounds UTF-8 log tails by maxBytes for allowed log paths', async () => {
    const stackHome = await mkdtemp(join(tmpdir(), 'rpc-bugreport-utf8-'));
    const stackName = 'utf8-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'runner.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimePath,
      JSON.stringify({
        stackName,
        logs: {
          runner: runnerLogPath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(runnerLogPath, `${'😀'.repeat(2_000)}\nEND\n`, 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimePath;

    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const logTailHandler = registered.get(RPC_METHODS.BUGREPORT_GET_LOG_TAIL);
      expect(logTailHandler).toBeDefined();
      const result = await logTailHandler!({
        path: runnerLogPath,
        maxBytes: 1024,
      });

      expect(result).toMatchObject({
        ok: true,
      });
      const byteLength = Buffer.byteLength(String(result.tail ?? ''), 'utf8');
      expect(byteLength).toBeLessThanOrEqual(1024);
      expect(String(result.tail ?? '')).toContain('END');
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('ignores stack runtime runner paths outside stack logs directory', async () => {
    const stackHome = await mkdtemp(join(tmpdir(), 'rpc-bugreport-stack-scope-'));
    const stackName = 'scope-stack';
    const stackBaseDir = join(stackHome, stackName);
    const stackLogsDir = join(stackBaseDir, 'logs');
    const envPath = join(stackBaseDir, 'env');
    const runtimePath = join(stackBaseDir, 'stack.runtime.json');
    const runnerLogPath = join(stackLogsDir, 'runner.log');
    const outsideRunnerPath = join(stackHome, 'outside-runner.log');

    await mkdir(stackLogsDir, { recursive: true });
    await writeFile(envPath, `HAPPIER_STACK_STACK=${stackName}\n`, 'utf8');
    await writeFile(
      runtimePath,
      JSON.stringify({
        stackName,
        logs: {
          runner: outsideRunnerPath,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(runnerLogPath, 'runner output\n', 'utf8');
    await writeFile(outsideRunnerPath, 'outside output\n', 'utf8');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    const previousStackName = process.env.HAPPIER_STACK_STACK;
    const previousEnvPath = process.env.HAPPIER_STACK_ENV_FILE;
    const previousRuntimePath = process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
    process.env.HAPPIER_STACK_STACK = stackName;
    process.env.HAPPIER_STACK_ENV_FILE = envPath;
    process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = runtimePath;

    try {
      registerMachineRpcHandlers({
        rpcHandlerManager,
        handlers: {
          spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
          stopSession: async () => true,
          requestShutdown: () => {},
        },
      });

      const collectHandler = registered.get(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
      expect(collectHandler).toBeDefined();
      const diagnostics = await collectHandler!({});

      expect(diagnostics.stackContext?.logCandidates).toContain(runnerLogPath);
      expect(diagnostics.stackContext?.logCandidates).not.toContain(outsideRunnerPath);
    } finally {
      if (previousStackName === undefined) {
        delete process.env.HAPPIER_STACK_STACK;
      } else {
        process.env.HAPPIER_STACK_STACK = previousStackName;
      }
      if (previousEnvPath === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = previousEnvPath;
      }
      if (previousRuntimePath === undefined) {
        delete process.env.HAPPIER_STACK_RUNTIME_STATE_PATH;
      } else {
        process.env.HAPPIER_STACK_RUNTIME_STATE_PATH = previousRuntimePath;
      }
    }
  });

  it('registers daemon memory handlers when memory worker is provided', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker: {
        stop: () => {},
        reloadSettings: async () => {},
        ensureUpToDate: async () => {},
        getEmbeddingsDiagnostics: () => ({
          mode: 'disabled' as const,
          presetId: null,
          providerKind: null,
          modelId: null,
          runtimeState: 'unavailable' as const,
          usingFallback: false,
          lastError: null,
        }),
        getWorkerStatus: () => ({
          state: 'idle' as const,
          lastTickAtMs: null,
          lastInventoryAtMs: null,
          currentSessionId: null,
          currentPhase: null,
        }),
        getSettings: () => ({
          ...DEFAULT_MEMORY_SETTINGS,
          v: 1,
          enabled: false,
          enabledAtMs: 0,
          indexMode: 'hints',
          defaultScope: { type: 'global' as const },
          backfillPolicy: 'new_only' as const,
          deleteOnDisable: false,
          hints: {
            ...DEFAULT_MEMORY_SETTINGS.hints,
            summarizerBackendId: 'claude',
            summarizerModelId: 'default',
            summarizerPermissionMode: 'no_tools',
            windowSizeMessages: 40,
            maxShardChars: 12_000,
            maxSummaryChars: 500,
            paddingMessagesOnVerify: 8,
            updateMode: 'onIdle',
            idleDelayMs: 30_000,
            maxRunsPerHour: 12,
            failureBackoffBaseMs: 60_000,
            failureBackoffMaxMs: 900_000,
            maxShardsPerSession: 250,
            maxKeywords: 12,
            maxEntities: 12,
            maxDecisions: 12,
          },
          deep: {
            ...DEFAULT_MEMORY_SETTINGS.deep,
            recentDays: 30,
            maxChunkChars: 12_000,
            maxChunkMessages: 50,
            minChunkMessages: 5,
            includeAssistantAcpMessage: true,
            includeToolOutput: false,
            candidateLimit: 200,
            previewChars: 800,
            failureBackoffBaseMs: 60_000,
            failureBackoffMaxMs: 3_600_000,
          },
          embeddings: {
            mode: 'disabled',
            presetId: 'balanced',
            custom: null,
            blend: {
              ftsWeight: 1,
              embeddingWeight: 1,
            },
          },
          budgets: {
            maxDiskMbLight: 64,
            maxDiskMbDeep: 512,
          },
          worker: {
            tickIntervalMs: 10_000,
            inventoryRefreshIntervalMs: 60_000,
            maxSessionsPerTick: 2,
            sessionListPageLimit: 50,
          },
        }),
        getTier1DbPath: () => null,
        getDeepDbPath: () => null,
      },
    });

    expect(registered.has((RPC_METHODS as any).DAEMON_MEMORY_SEARCH)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_MEMORY_GET_WINDOW)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_MEMORY_STATUS)).toBe(true);
  });

  it('registers direct sessions handlers', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_LINK_ENSURE)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_ATTACH)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_DETACH)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_STATUS_GET)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_EXTERNAL_SESSION_TAKEOVER)).toBe(true);
    expect(registered.has(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY)).toBe(true);
  });

  it('drops stale direct transfer handlers when the machine rpc surface is re-registered without transfer capability', async () => {
    const { RpcHandlerManager } = await import('../rpc/RpcHandlerManager');

    const rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
    });

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
        directTransferImport: {
          prepareImportSession: async () => ({
            uploadId: 'upload-1',
            destDisplayPath: 'payload.bin',
            expectedSizeBytes: 4,
            chunkSizeBytes: 8,
            recipientPublicKeyBase64: 'recipient-key',
            expiresAt: 5_000,
            endpointCandidates: [],
          }),
          abortImportSession: async () => {},
        },
        directTransferExport: {
          prepareExportSession: async () => ({
            transferId: 'transfer-1',
            endpointCandidates: [],
            expiresAt: 5_000,
          }),
        },
      },
    });

    expect(rpcHandlerManager.hasHandler(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(true);
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE)).toBe(true);
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toBe(true);

    const socketEmit = vi.fn();
    (rpcHandlerManager as any).socket = {
      emit: socketEmit,
    };

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's2' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(rpcHandlerManager.hasHandler(RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(true);
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE)).toBe(false);
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toBe(false);
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTER, {
      method: `machine-test:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE}`,
    });
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.UNREGISTER, {
      method: `machine-test:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`,
    });
  });

  it('registers session handoff handlers', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineRpcHandlers({
      rpcHandlerManager,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(registered.has((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_START)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_PREPARE_TARGET)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_COMMIT)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_ABORT)).toBe(true);
    expect(registered.has((RPC_METHODS as any).DAEMON_SESSION_HANDOFF_STATUS_GET)).toBe(true);
  });

});
