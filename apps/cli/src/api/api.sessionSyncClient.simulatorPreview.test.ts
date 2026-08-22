import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

const apiSessionClientConstructorMock = vi.hoisted(() => vi.fn());

vi.mock('./session/sessionClient', () => ({
  ApiSessionClient: class {
    constructor(...args: unknown[]) {
      apiSessionClientConstructorMock(...args);
    }
  },
}));

vi.mock('./pushNotifications', () => ({
  PushNotificationClient: class {},
}));

vi.mock('./client/connectedServiceCredentialApi', () => ({
  createConnectedServiceCredentialApi: () => ({}),
  ConnectedServiceCredentialUnsupportedFormatError: class extends Error {},
}));

describe('ApiClient sessionSyncClient runtime-action routes', () => {
  beforeEach(() => {
    apiSessionClientConstructorMock.mockClear();
  });

  it('passes configured runtime-action route providers to session clients', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    const simulatorPreview = {
      getSnapshot: vi.fn(),
      dispatchAction: vi.fn(),
    };
    const localServices = {
      inventoryRoutes: {
        getSnapshot: vi.fn(),
        refreshSnapshot: vi.fn(),
      },
      launcherRoutes: {
        getSnapshot: vi.fn(),
      },
      previewRoutes: {
        getSnapshot: vi.fn(),
      },
      actionRoutes: {
        execute: vi.fn(),
      },
    };

    api.setLocalServicesRuntimeActionRoutesProvider(() => localServices);
    api.setSimulatorPreviewRoutesProvider(() => simulatorPreview);
    api.sessionSyncClient({ id: 'session_1' } as never);

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      getLocalServicesRuntimeActionRoutes?: () => unknown;
      getSimulatorPreviewRoutes?: () => unknown;
    }> | undefined;
    expect(options?.getLocalServicesRuntimeActionRoutes?.()).toBe(localServices);
    expect(options?.getSimulatorPreviewRoutes?.()).toBe(simulatorPreview);
  }, 60_000);

  it('passes the local runtime machine id to session clients', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);

    api.setLocalMachineId(' machine-local ');
    api.sessionSyncClient({ id: 'session_1' } as never);

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      localMachineId?: string;
    }> | undefined;
    expect(options?.localMachineId).toBe('machine-local');
  }, 60_000);

  it('dispatches plugin browser actions through the current daemon route owner', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    api.setServerFeaturesSnapshotProvider(() => ({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          browser: {
            enabled: true,
            viewTargets: { enabled: true },
            internal: { enabled: true },
            sidecar: { enabled: true },
          },
        },
      }),
    }));
    const firstDispatch = vi.fn(async (command: Readonly<{ commandId: string }>) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    const secondDispatch = vi.fn(async (command: Readonly<{ commandId: string }>) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    let currentRoutes = { dispatchCommand: firstDispatch };
    api.setBrowserDaemonControlRoutesProvider(() => currentRoutes);
    const execute = api.createBrowserRuntimeActionExecutor();
    const input = {
      kind: 'navigate',
      commandId: 'command-1',
      browserSessionId: 'browser-session-1',
      viewId: 'view-1',
      url: 'https://example.com',
    } as const;

    await expect(execute({
      actionId: 'browser.navigate',
      input,
      context: {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
      },
    })).resolves.toMatchObject({ status: 'dispatched' });

    currentRoutes = { dispatchCommand: secondDispatch };
    await expect(execute({
      actionId: 'browser.navigate',
      input: { ...input, commandId: 'command-2' },
      context: {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
      },
    })).resolves.toMatchObject({ commandId: 'command-2', status: 'dispatched' });
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(secondDispatch).toHaveBeenCalledOnce();

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(execute({
      actionId: 'browser.navigate',
      input: { ...input, commandId: 'command-cancelled' },
      context: {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
        signal: cancelled.signal,
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondDispatch).toHaveBeenCalledOnce();
  }, 60_000);

  it('passes the scoped session-input transformer and post-admission attachment notifier to the session owner', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    const transformSessionInputBeforeCommit = vi.fn(async (
      payload: Record<string, unknown>,
    ) => payload);
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);

    api.sessionSyncClient(
      { id: 'session_1' } as never,
      {
        transformSessionInputBeforeCommit,
        afterComposerAttachmentMessageAccepted,
      },
    );

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      transformSessionInputBeforeCommit?: unknown;
      afterComposerAttachmentMessageAccepted?: unknown;
    }> | undefined;
    expect(options?.transformSessionInputBeforeCommit).toBe(
      transformSessionInputBeforeCommit,
    );
    expect(options?.afterComposerAttachmentMessageAccepted).toBe(
      afterComposerAttachmentMessageAccepted,
    );
  }, 60_000);
});
