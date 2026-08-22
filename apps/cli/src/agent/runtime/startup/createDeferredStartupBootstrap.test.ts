import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type {
  ApiSessionClient,
  ApiSessionClientOptions,
} from '@/api/session/sessionClient';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { DeferredApiSessionClient } from './DeferredApiSessionClient';
import { createDeferredStartupBootstrap } from './createDeferredStartupBootstrap';

describe('createDeferredStartupBootstrap', () => {
  it('does not create or persist a server session after cancellation wins during API initialization', async () => {
    type ApiContext = Readonly<{ api: ApiClient; machineId: string }>;
    let resolveApiContext!: (value: ApiContext) => void;
    const apiContext = new Promise<ApiContext>((resolve) => {
      resolveApiContext = resolve;
    });
    const initializeBackendRunSessionFn = vi.fn();
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => await apiContext,
        initializeBackendRunSessionFn,
      },
    });

    const startPromise = bootstrap.start?.();
    const cancel = bootstrap.cancel;
    if (typeof cancel !== 'function') {
      throw new Error('expected deferred startup cancellation');
    }
    cancel();
    await startPromise;
    resolveApiContext({
      api: {
        push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => undefined),
        }),
      } as unknown as ApiClient,
      machineId: 'machine-1',
    });
    await Promise.resolve();

    expect(initializeBackendRunSessionFn).not.toHaveBeenCalled();
  });

  it('settles startup and disposes a late successful session initialization after cancellation', async () => {
    let sessionInitializationEntered!: () => void;
    const sessionInitializationEnteredPromise = new Promise<void>((resolve) => {
      sessionInitializationEntered = resolve;
    });
    let lateSessionClosed!: () => void;
    const lateSessionClosedPromise = new Promise<void>((resolve) => {
      lateSessionClosed = resolve;
    });
    const lateSessionClose = vi.fn(async () => {
      lateSessionClosed();
    });
    const lateReconnectionCancel = vi.fn();
    let resolveSessionInitialization!: (value: {
      session: ApiSessionClient;
      reconnectionHandle: { cancel: () => void } | null;
      reportedSessionId: string | null;
      attachedToExistingSession: boolean;
    }) => void;
    const sessionInitialization = new Promise<{
      session: ApiSessionClient;
      reconnectionHandle: { cancel: () => void } | null;
      reportedSessionId: string | null;
      attachedToExistingSession: boolean;
    }>((resolve) => {
      resolveSessionInitialization = resolve;
    });
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => undefined),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async () => {
          sessionInitializationEntered();
          return await sessionInitialization;
        },
      },
    });
    const startPromise = bootstrap.start?.();
    if (!startPromise) throw new Error('expected deferred startup start');
    await sessionInitializationEnteredPromise;
    const cancel = bootstrap.cancel;
    if (typeof cancel !== 'function') throw new Error('expected deferred startup cancellation');
    cancel();

    await expect(startPromise).resolves.toBeUndefined();
    resolveSessionInitialization({
      session: { close: lateSessionClose } as unknown as ApiSessionClient,
      reconnectionHandle: { cancel: lateReconnectionCancel },
      reportedSessionId: 'late-session',
      attachedToExistingSession: false,
    });
    await lateSessionClosedPromise;
    expect(lateReconnectionCancel).toHaveBeenCalledOnce();
    expect(lateSessionClose).toHaveBeenCalledOnce();
  });

  it('publishes the resolved machine id before starting background session attach', async () => {
    const order: string[] = [];
    const pushSender = {
      sendToAllDevices: vi.fn(),
      sendToAllDevicesAsync: vi.fn(async () => undefined),
    };
    const attachedSession = {
      sessionId: 'session-live',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      sendSessionEvent: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(),
    } as unknown as ApiSessionClient;
    const onSessionAttached = vi.fn(async () => {
      order.push('attached');
    });
    const onPushSenderReady = vi.fn(async () => {
      order.push('push');
    });
    const sessionSyncClient = vi.fn(() => attachedSession);
    const transformSessionInputBeforeCommit = vi.fn(async (
      payload: Record<string, unknown>,
    ) => payload);
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);
    const machineAdmissionTransport = vi.fn(async (
      request: Parameters<NonNullable<
        ApiSessionClientOptions['machineAdmissionTransport']
      >>[0],
    ) => ({
      status: 'accepted' as const,
      localId: request.localId,
    }));
    // Boundary fixture: this test only exercises push-sender propagation.
    const api = {
      push: () => pushSender,
      sessionSyncClient,
    } as unknown as ApiClient;
    const initialMutation = { fieldId: 'runtime.activity' } as const;

    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      existingSessionId: undefined,
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      onSessionAttached,
      onPushSenderReady,
      createInitialRegisteredSessionStateFieldMutations: () => [
        initialMutation as never,
      ],
      transformSessionInputBeforeCommit,
      afterComposerAttachmentMessageAccepted,
      machineAdmissionTransport,
      deps: {
        initializeBackendApiContextFn: async () => ({
          api,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async ({ api: runtimeApi }) => {
          const session = runtimeApi.sessionSyncClient({
            id: 'session-live',
          } as never);
          return {
            session,
            reconnectionHandle: { cancel: vi.fn() },
            reportedSessionId: 'session-live',
            attachedToExistingSession: false,
          };
        },
      },
    });

    expect(bootstrap.session).toBeInstanceOf(DeferredApiSessionClient);
    expect(bootstrap.machineId).toBe('machine-1');
    expect(bootstrap.metadata).toEqual(expect.objectContaining({
      machineId: 'machine-1',
    }));

    await (
      bootstrap.start as unknown as (
        options: Readonly<{
          prepareSession(session: ApiSessionClient): Promise<void>;
        }>,
      ) => Promise<void>
    )({
      prepareSession: async (session) => {
        expect(session).toBe(attachedSession);
        order.push('prepare');
      },
    });

    expect(onSessionAttached).toHaveBeenCalledWith({
      session: attachedSession,
      machineId: 'machine-1',
    });
    expect(onPushSenderReady).toHaveBeenCalledWith(pushSender);
    expect(sessionSyncClient).toHaveBeenCalledWith(
      { id: 'session-live' },
      {
        initialRegisteredSessionStateFieldMutations: [initialMutation],
        durableMutationDeliveryInitiallyActive: false,
        transformSessionInputBeforeCommit,
        afterComposerAttachmentMessageAccepted,
        machineAdmissionTransport,
      },
    );
    expect(order).toEqual(['prepare', 'attached', 'push']);
  });

  it('keeps the initial machine id in bootstrap metadata and publishes rotated identity on attach', async () => {
    const attachedSession = {
      sessionId: 'session-live',
      getMetadataSnapshot: vi.fn(() => null),
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(),
    } as unknown as ApiSessionClient;
    const onSessionAttached = vi.fn(async () => undefined);

    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-stale',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      existingSessionId: undefined,
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
        machineId: 'machine-stale',
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      onSessionAttached,
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => undefined),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-rotated',
        }),
        initializeBackendRunSessionFn: async ({ onSessionSwap }) => {
          await onSessionSwap?.(attachedSession);
          return {
            session: attachedSession,
            reconnectionHandle: { cancel: vi.fn() },
            reportedSessionId: 'session-live',
            attachedToExistingSession: false,
          };
        },
      },
    });

    expect(bootstrap.machineId).toBe('machine-stale');
    expect(bootstrap.metadata).toEqual(expect.objectContaining({
      machineId: 'machine-stale',
    }));

    await bootstrap.start?.();

    expect(onSessionAttached).toHaveBeenCalledWith({
      session: attachedSession,
      machineId: 'machine-rotated',
    });
    expect(bootstrap.session.getMetadataSnapshot?.()).toBeNull();
  });

  it('rejects startup instead of continuing without a durable Session', async () => {
    const sessionUnavailable = Object.assign(
      new Error('Unable to start without a durable Session'),
      {
        name: 'BackendRunSessionUnavailableError',
        code: 'backend_run_session_unavailable' as const,
      },
    );
    const onBackgroundStartFailure = vi.fn();
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      onBackgroundStartFailure,
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => undefined),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async () => {
          throw sessionUnavailable;
        },
      },
    });

    await expect(bootstrap.start?.()).rejects.toBe(sessionUnavailable);
    expect(onBackgroundStartFailure).toHaveBeenCalledExactlyOnceWith(sessionUnavailable);
  });

  it('propagates required session-authority preparation failure instead of continuing local readiness', async () => {
    const authorityFailure = new Error('required startup snapshot refresh failed');
    const deactivateDurableMutationDelivery = vi.fn();
    const close = vi.fn(async () => undefined);
    const attachedSession = {
      sessionId: 'session-live',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      deactivateDurableMutationDelivery,
      close,
    } as unknown as ApiSessionClient;
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 't' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata: {
        host: 'host',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happy',
        happyLibDir: '/tmp/lib',
      },
      sessionTag: 'session-tag',
      initialMetadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as never,
      createInitializedSessionMetadata: (machineId) => ({
        metadata: {
          path: '/tmp/workspace',
          permissionMode: 'default',
          permissionModeUpdatedAt: 1,
          machineId,
        } as never,
        state: { controlledByUser: false },
      }),
      uiLogPrefix: '[test]',
      startupMetadataOverrides: createStartupMetadataOverrides({
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => undefined),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
        initializeBackendRunSessionFn: async () => ({
          session: attachedSession,
          reconnectionHandle: null,
          reportedSessionId: 'session-live',
          attachedToExistingSession: false,
        }),
      },
    });

    await expect(bootstrap.start?.({
      prepareSession: async () => {
        throw authorityFailure;
      },
    })).rejects.toBe(authorityFailure);

    expect(deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
