import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type BrokerModule = Readonly<{
  createBrowserDaemonControlBroker?: () => {
    registerAdapter(adapter: {
      adapterKind: 'chromiumSidecar' | 'streamedBrowserSurface';
      ownsView(input: { browserSessionId: string; viewId: string }): boolean;
      supportsOpenView(command: Extract<BrowserCommandV1, { kind: 'openView' }>): boolean;
      dispatchCommand(command: BrowserCommandV1): Promise<unknown> | unknown;
    }): () => void;
    dispatchCommand(command: BrowserCommandV1): Promise<unknown>;
    hasExecutableAdapters(): boolean;
  };
}>;

async function loadBroker(): Promise<BrokerModule | null> {
  return import('./broker') as Promise<BrokerModule | null>;
}

function navigateCommand(overrides: Partial<Extract<BrowserCommandV1, { kind: 'navigate' }>> = {}) {
  return {
    kind: 'navigate',
    commandId: 'command_navigate',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    url: 'https://browser.example.test/next',
    ...overrides,
  } satisfies BrowserCommandV1;
}

function openViewCommand(overrides: Partial<Extract<BrowserCommandV1, { kind: 'openView' }>> = {}) {
  const { focus = true, ...rest } = overrides;
  return {
    kind: 'openView',
    commandId: 'command_open',
    browserSessionId: 'browser_session_1',
    viewId: 'view_2',
    platform: 'web',
    focus,
    target: {
      kind: 'externalUrl',
      targetId: 'external_url_1',
      url: 'https://browser.example.test/',
    },
    ...rest,
  } satisfies BrowserCommandV1;
}

describe('browser daemon control broker', () => {
  it('returns a typed failure when no adapter owns browser control', async () => {
    const mod = await loadBroker();

    expect(mod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlBroker) return;

    const broker = mod.createBrowserDaemonControlBroker();

    expect(broker.hasExecutableAdapters()).toBe(false);
    await expect(broker.dispatchCommand(navigateCommand())).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      error: { code: 'adapter_unavailable' },
    });
  });

  it('routes view commands only to the registered owner for the browser session and view', async () => {
    const mod = await loadBroker();

    expect(mod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlBroker) return;

    const broker = mod.createBrowserDaemonControlBroker();
    const owner = vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    const other = vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'streamedBrowserSurface' as const,
      events: [],
    }));

    broker.registerAdapter({
      adapterKind: 'chromiumSidecar',
      ownsView: ({ browserSessionId, viewId }) => browserSessionId === 'browser_session_1' && viewId === 'view_1',
      supportsOpenView: () => false,
      dispatchCommand: owner,
    });
    broker.registerAdapter({
      adapterKind: 'streamedBrowserSurface',
      ownsView: ({ browserSessionId, viewId }) => browserSessionId === 'browser_session_1' && viewId === 'view_2',
      supportsOpenView: () => false,
      dispatchCommand: other,
    });

    await expect(broker.dispatchCommand(navigateCommand())).resolves.toMatchObject({
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
    });
    expect(owner).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();

    await expect(broker.dispatchCommand(navigateCommand({ viewId: 'stale_view' }))).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'view_not_found' },
    });
  });

  it('routes openView only to an adapter that declares support', async () => {
    const mod = await loadBroker();

    expect(mod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlBroker) return;

    const broker = mod.createBrowserDaemonControlBroker();
    const unsupported = vi.fn(async () => {
      throw new Error('unsupported adapter should not receive openView');
    });
    const supported = vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'streamedBrowserSurface' as const,
      events: [],
    }));

    broker.registerAdapter({
      adapterKind: 'chromiumSidecar',
      ownsView: () => false,
      supportsOpenView: () => false,
      dispatchCommand: unsupported,
    });
    broker.registerAdapter({
      adapterKind: 'streamedBrowserSurface',
      ownsView: () => false,
      supportsOpenView: (command) => command.target.kind === 'externalUrl',
      dispatchCommand: supported,
    });

    await expect(broker.dispatchCommand(openViewCommand())).resolves.toMatchObject({
      status: 'dispatched',
      adapterKind: 'streamedBrowserSurface',
    });
    expect(unsupported).not.toHaveBeenCalled();
    expect(supported).toHaveBeenCalledOnce();

    await expect(broker.dispatchCommand(openViewCommand({
      target: {
        kind: 'localServicePreview',
        targetId: 'preview_1',
        sessionId: 'session_1',
        machineId: 'machine_1',
      },
    }))).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'unsupported_command' },
    });
  });

  it('fails closed for stale owners and unsupported session commands', async () => {
    const mod = await loadBroker();

    expect(mod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlBroker) return;

    const broker = mod.createBrowserDaemonControlBroker();
    const dispatchCommand = vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    const unregister = broker.registerAdapter({
      adapterKind: 'chromiumSidecar',
      ownsView: ({ viewId }) => viewId === 'view_1',
      supportsOpenView: () => false,
      dispatchCommand,
    });

    unregister();

    await expect(broker.dispatchCommand(navigateCommand())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'view_not_found' },
    });
    await expect(broker.dispatchCommand({
      kind: 'createSession',
      commandId: 'command_create_session',
    })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'unsupported_command' },
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it('rejects adapter results that are not bound to the dispatched command and adapter owner', async () => {
    const mod = await loadBroker();

    expect(mod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlBroker) return;

    const broker = mod.createBrowserDaemonControlBroker();
    const dispatchCommand = vi.fn(async () => ({
      v: 1 as const,
      commandId: 'different_command',
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    broker.registerAdapter({
      adapterKind: 'chromiumSidecar',
      ownsView: ({ viewId }) => viewId === 'view_1',
      supportsOpenView: () => false,
      dispatchCommand,
    });

    await expect(broker.dispatchCommand(navigateCommand())).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
      error: { code: 'adapter_unavailable' },
    });
  });

  it('rejects adapter results that report a different or non-daemon semantic adapter kind', async () => {
    const mod = await loadBroker();

    expect(mod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlBroker) return;

    const broker = mod.createBrowserDaemonControlBroker();
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        v: 1 as const,
        commandId: 'command_navigate',
        status: 'dispatched' as const,
        adapterKind: 'streamedBrowserSurface' as const,
        events: [],
      })
      .mockResolvedValueOnce({
        v: 1 as const,
        commandId: 'command_navigate',
        status: 'dispatched' as const,
        adapterKind: 'externalUrl' as const,
        events: [],
      });
    broker.registerAdapter({
      adapterKind: 'chromiumSidecar',
      ownsView: ({ viewId }) => viewId === 'view_1',
      supportsOpenView: () => false,
      dispatchCommand,
    });

    await expect(broker.dispatchCommand(navigateCommand())).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
      error: { code: 'adapter_unavailable' },
    });
    await expect(broker.dispatchCommand(navigateCommand())).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      adapterKind: 'chromiumSidecar',
      error: { code: 'adapter_unavailable' },
    });
  });
});
