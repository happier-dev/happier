import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createStartupMetadataOverrides } from '@/agent/runtime/createStartupMetadataOverrides';
import { DeferredApiSessionClient } from './DeferredApiSessionClient';
import { createDeferredStartupBootstrap } from './createDeferredStartupBootstrap';

describe('createDeferredStartupBootstrap', () => {
  it('publishes the resolved machine id before starting background session attach', async () => {
    const pushSender = {
      sendToAllDevices: vi.fn(),
      sendToAllDevicesAsync: vi.fn(async () => undefined),
    };
    const attachedSession = {
      sessionId: 'session-live',
      getMetadataSnapshot: vi.fn(() => null),
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(),
    } as unknown as ApiSessionClient;
    const onSessionAttached = vi.fn(async () => undefined);
    const onPushSenderReady = vi.fn(async () => undefined);
    // Boundary fixture: this test only exercises push-sender propagation.
    const api = {
      push: () => pushSender,
    } as unknown as ApiClient;

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
      deps: {
        initializeBackendApiContextFn: async () => ({
          api,
          machineId: 'machine-1',
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

    expect(bootstrap.session).toBeInstanceOf(DeferredApiSessionClient);
    expect(bootstrap.machineId).toBe('machine-1');
    expect(bootstrap.metadata).toEqual(expect.objectContaining({
      machineId: 'machine-1',
    }));

    await bootstrap.start?.();

    expect(onSessionAttached).toHaveBeenCalledWith({
      session: attachedSession,
      machineId: 'machine-1',
    });
    expect(onPushSenderReady).toHaveBeenCalledWith(pushSender);
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

  it('keeps local startup alive and buffers a startup warning when background attach fails', async () => {
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
          throw new Error('background attach failed');
        },
      },
    });

    await expect(bootstrap.start?.()).resolves.toBeUndefined();

    const deliveredEvents: unknown[] = [];
    await (bootstrap.session as unknown as DeferredApiSessionClient).attach({
      sessionId: 'session-live',
      rpcHandlerManager: {
        registerHandler: vi.fn(),
        invokeLocal: vi.fn(async () => ({})),
      },
      sendSessionEvent: (event: unknown) => {
        deliveredEvents.push(event);
      },
      sendProviderMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      getMetadataSnapshot: vi.fn(() => null),
      waitForMetadataUpdate: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as Parameters<DeferredApiSessionClient['attach']>[0]);

    expect(deliveredEvents).toContainEqual({
      type: 'message',
      message:
        '[startup-background-error] Failed to initialize Happy session in the background. Local mode may continue, but remote sync/switching could be unavailable.',
    });
  });
});
