import {
  BrowserCommandDispatchResultV1Schema,
  type BrowserCommandV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type RoutesModule = Readonly<{
  createBrowserDaemonControlRoutes?: (input: {
    broker: {
      dispatchCommand(command: BrowserCommandV1): Promise<unknown> | unknown;
    };
  }) => {
    dispatchCommand(command: unknown): Promise<unknown>;
  };
}>;

async function loadRoutes(): Promise<RoutesModule | null> {
  return import('./routes') as Promise<RoutesModule | null>;
}

describe('browser daemon control routes', () => {
  it('returns a typed malformed-command result for invalid BrowserCommandV1 input', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const routes = mod.createBrowserDaemonControlRoutes({
      broker: {
        dispatchCommand: vi.fn(),
      },
    });

    await expect(routes.dispatchCommand({
      kind: 'navigate',
      commandId: 'command_bad',
      url: 'https://browser.example.test/',
    })).resolves.toMatchObject({
      v: 1,
      commandId: 'command_bad',
      status: 'failed',
      error: { code: 'command_malformed' },
    });
  });

  it('returns a schema-valid malformed-command result when the malformed input command id is unsafe', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const routes = mod.createBrowserDaemonControlRoutes({
      broker: {
        dispatchCommand: vi.fn(),
      },
    });
    const result = await routes.dispatchCommand({
      kind: 'navigate',
      commandId: 'x'.repeat(300),
      url: 'https://browser.example.test/',
    });

    expect(result).toMatchObject({
      v: 1,
      commandId: 'unknown',
      status: 'failed',
      error: { code: 'command_malformed' },
    });
    expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
  });

  it('delegates valid commands to the broker and returns the parsed dispatch result', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const command = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://browser.example.test/next',
    } satisfies BrowserCommandV1;
    const dispatchCommand = vi.fn(async () => ({
      v: 1,
      commandId: 'command_navigate',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    }));
    const routes = mod.createBrowserDaemonControlRoutes({
      broker: { dispatchCommand },
    });

    await expect(routes.dispatchCommand(command)).resolves.toEqual({
      v: 1,
      commandId: 'command_navigate',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    });
    expect(dispatchCommand).toHaveBeenCalledWith(command);
  });

  it('rejects broker results that are not bound to the dispatched command or daemon adapter kinds', async () => {
    const mod = await loadRoutes();

    expect(mod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonControlRoutes) return;

    const command = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://browser.example.test/next',
    } satisfies BrowserCommandV1;
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce({
        v: 1,
        commandId: 'different_command',
        status: 'dispatched',
        adapterKind: 'chromiumSidecar',
        events: [],
      })
      .mockResolvedValueOnce({
        v: 1,
        commandId: 'command_navigate',
        status: 'dispatched',
        adapterKind: 'externalUrl',
        events: [],
      });
    const routes = mod.createBrowserDaemonControlRoutes({
      broker: { dispatchCommand },
    });

    await expect(routes.dispatchCommand(command)).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      error: { code: 'adapter_unavailable' },
    });
    await expect(routes.dispatchCommand(command)).resolves.toMatchObject({
      v: 1,
      commandId: 'command_navigate',
      status: 'failed',
      error: { code: 'adapter_unavailable' },
    });
  });
});
