import { createSurfaceContextFixture, SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type {
  PluginUiHostApi,
  ResourceContent,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';

/**
 * Test-only surface fixtures for this package's own RED/GREEN loop.
 *
 * This aliases the public SDK builder exactly: package-local tests may add a
 * host stub, but there is one authoritative context/theme fixture shape.
 */
export const SURFACE_THEME_FIXTURE = SURFACE_CONTEXT_THEME_FIXTURE;
export const createSurfaceContext: (overrides?: Partial<SurfaceContext>) => SurfaceContext = createSurfaceContextFixture;

export function createHostApiStub(
  context: SurfaceContext = createSurfaceContext(),
  overrides: Partial<PluginUiHostApi> = {},
): PluginUiHostApi {
  const resource: ResourceContent = {
    contentType: 'application/json',
    digest: `sha256:${'1'.repeat(64)}`,
    bytes: new TextEncoder().encode('{"status":"ready"}'),
  };

  return {
    version: () => ({ apiVersion: PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.ui.hostApiVersion, wireVersion: 1, methods: [] }),
    context: async () => context,
    watchContext: async (): Promise<Disposable> => ({ dispose() {} }),
    executeAction: async () => null,
    selectActionInput: async () => ({ kind: 'cancelled' as const }),
    readResource: async () => resource,
    statOpenableContent: async () => { throw new Error('unsupported_host_method'); },
    readOpenableContent: async () => { throw new Error('unsupported_host_method'); },
    watchResource: async () => { throw new Error('unsupported_host_method'); },
    openSurface: async () => undefined,
    notify: async () => undefined,
    confirm: async () => false,
    diagnostic: () => undefined,
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    openExternalLink: async () => undefined,
    ...overrides,
  } as PluginUiHostApi;
}
