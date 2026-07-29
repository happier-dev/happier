import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('prefers an explicitly scoped session-input transformer over process-global hook resolution', async () => {
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

    api.sessionSyncClient(
      { id: 'session_1' } as never,
      { transformSessionInputBeforeCommit },
    );

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      transformSessionInputBeforeCommit?: unknown;
    }> | undefined;
    expect(options?.transformSessionInputBeforeCommit).toBe(
      transformSessionInputBeforeCommit,
    );
  }, 60_000);
});
