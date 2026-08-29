import { describe, expect, it, vi } from 'vitest';

describe('daemon machine RPC route attachments', () => {
  it('caches route families and reattaches browser recording routes when machine RPC becomes available later', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const localServicesPreview = { getSnapshot: vi.fn() };
    const localServices = {
      localServicesInventory: { getSnapshot: vi.fn(), refreshSnapshot: vi.fn() },
      localServicesLauncher: { getSnapshot: vi.fn(), startTarget: vi.fn() },
      localServicesPreview,
      localServicesActions: { execute: vi.fn() },
    };
    const browserDiagnostics = { getSnapshot: vi.fn() };
    const browserContext = { dispatch: vi.fn() };
    const browserRecording = { startRecording: vi.fn() };
    const simulatorPreview = { getSnapshot: vi.fn(), dispatchAction: vi.fn() };
    let apiMachineForSessions: null | {
      registerLocalServicesPreviewRoutes: ReturnType<typeof vi.fn>;
      registerLocalServicesRoutes: ReturnType<typeof vi.fn>;
      registerBrowserContextRoutes: ReturnType<typeof vi.fn>;
      registerBrowserDiagnosticsRoutes: ReturnType<typeof vi.fn>;
      registerBrowserRecordingRoutes: ReturnType<typeof vi.fn>;
      registerSimulatorPreviewRoutes: ReturnType<typeof vi.fn>;
    } = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    });

    cache.attachLocalServicesPreviewRoutes(localServicesPreview as never);
    cache.attachLocalServicesRoutes(localServices as never);
    cache.attachBrowserContextRoutes(browserContext as never);
    cache.attachBrowserDiagnosticsRoutes(browserDiagnostics as never);
    cache.attachBrowserRecordingRoutes(browserRecording as never);
    cache.attachSimulatorPreviewRoutes(simulatorPreview as never);

    apiMachineForSessions = {
      registerLocalServicesPreviewRoutes: vi.fn(),
      registerLocalServicesRoutes: vi.fn(),
      registerBrowserContextRoutes: vi.fn(),
      registerBrowserDiagnosticsRoutes: vi.fn(),
      registerBrowserRecordingRoutes: vi.fn(),
      registerSimulatorPreviewRoutes: vi.fn(),
    };
    cache.attachApiMachineForSessions(apiMachineForSessions as never);

    expect(apiMachineForSessions.registerLocalServicesPreviewRoutes).toHaveBeenCalledWith(localServicesPreview);
    expect(apiMachineForSessions.registerLocalServicesRoutes).toHaveBeenCalledWith({
      localServicesInventory: localServices.localServicesInventory,
      localServicesLauncher: localServices.localServicesLauncher,
      localServicesActions: localServices.localServicesActions,
    });
    expect(apiMachineForSessions.registerBrowserContextRoutes).toHaveBeenCalledWith(browserContext);
    expect(apiMachineForSessions.registerBrowserDiagnosticsRoutes).toHaveBeenCalledWith(browserDiagnostics);
    expect(apiMachineForSessions.registerBrowserRecordingRoutes).toHaveBeenCalledWith(browserRecording);
    expect(apiMachineForSessions.registerSimulatorPreviewRoutes).toHaveBeenCalledWith(simulatorPreview);
  });

  it('registers browser recording routes immediately when machine RPC is already available', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const apiMachineForSessions = {
      registerLocalServicesPreviewRoutes: vi.fn(),
      registerLocalServicesRoutes: vi.fn(),
      registerBrowserContextRoutes: vi.fn(),
      registerBrowserDiagnosticsRoutes: vi.fn(),
      registerBrowserRecordingRoutes: vi.fn(),
      registerSimulatorPreviewRoutes: vi.fn(),
    };
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    });
    const browserRecording = { startRecording: vi.fn() };

    cache.attachBrowserRecordingRoutes(browserRecording as never);

    expect(apiMachineForSessions.registerBrowserRecordingRoutes).toHaveBeenCalledWith(browserRecording);
  });

  it('caches the connected-account daemon runtime and reattaches it to a replacement machine client', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const runtime: import('./connectedServices/ConnectedAccountDaemonRuntime').ConnectedAccountDaemonRuntime = {
      execute: vi.fn(),
      control: vi.fn(),
    };
    let apiMachineForSessions: null | {
      registerConnectedAccountDaemonRuntime: ReturnType<typeof vi.fn>;
      registerConnectedAccountPurposeBindingRuntime: ReturnType<typeof vi.fn>;
    } = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    }) as unknown as {
      attachConnectedAccountDaemonRuntime(
        connectedAccountRuntime: import('./connectedServices/ConnectedAccountDaemonRuntime').ConnectedAccountDaemonRuntime,
      ): void;
      attachApiMachineForSessions(apiMachine: typeof apiMachineForSessions): void;
    };

    cache.attachConnectedAccountDaemonRuntime(runtime);
    apiMachineForSessions = {
      registerConnectedAccountDaemonRuntime: vi.fn(),
      registerConnectedAccountPurposeBindingRuntime: vi.fn(),
    };
    cache.attachApiMachineForSessions(apiMachineForSessions);

    expect(apiMachineForSessions.registerConnectedAccountDaemonRuntime)
      .toHaveBeenCalledWith(runtime);
  });

  it('attaches the Connected Account Action-form purpose producer before and after machine replacement', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const runtime = {
      activatePurposeBindings: vi.fn(),
      listActionFormConnectedAccountOptions: vi.fn(),
    };
    let apiMachineForSessions: null | {
      registerConnectedAccountDaemonRuntime: ReturnType<typeof vi.fn>;
      registerConnectedAccountPurposeBindingRuntime: ReturnType<typeof vi.fn>;
    } = null;
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    }) as unknown as {
      attachConnectedAccountPurposeBindingRuntime(value: typeof runtime): void;
      attachApiMachineForSessions(apiMachine: typeof apiMachineForSessions): void;
    };

    cache.attachConnectedAccountPurposeBindingRuntime(runtime);
    apiMachineForSessions = {
      registerConnectedAccountDaemonRuntime: vi.fn(),
      registerConnectedAccountPurposeBindingRuntime: vi.fn(),
    };
    cache.attachApiMachineForSessions(apiMachineForSessions);

    expect(apiMachineForSessions.registerConnectedAccountPurposeBindingRuntime)
      .toHaveBeenCalledWith(runtime);
  });

  it('lets the combined local-services route family own preview when it arrives first', async () => {
    const { createDaemonMachineRpcRouteAttachmentCache } = await import('./machineRpcRouteAttachments');
    const apiMachineForSessions = {
      registerLocalServicesPreviewRoutes: vi.fn(),
      registerLocalServicesRoutes: vi.fn(),
      registerBrowserContextRoutes: vi.fn(),
      registerBrowserDiagnosticsRoutes: vi.fn(),
      registerBrowserRecordingRoutes: vi.fn(),
      registerSimulatorPreviewRoutes: vi.fn(),
    };
    const cache = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions as never,
    });
    const preview = { getSnapshot: vi.fn() };
    const localServices = {
      localServicesInventory: { getSnapshot: vi.fn(), refreshSnapshot: vi.fn() },
      localServicesLauncher: { getSnapshot: vi.fn(), startTarget: vi.fn() },
      localServicesPreview: preview,
      localServicesActions: { execute: vi.fn() },
    };

    cache.attachLocalServicesRoutes(localServices as never);
    cache.attachLocalServicesPreviewRoutes(preview as never);

    expect(apiMachineForSessions.registerLocalServicesRoutes).toHaveBeenCalledWith(localServices);
    expect(apiMachineForSessions.registerLocalServicesPreviewRoutes).not.toHaveBeenCalled();
  });
});
