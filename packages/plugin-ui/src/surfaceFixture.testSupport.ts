import { createSurfaceContextFixture, SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
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
export const SURFACE_THEME_FIXTURE: SurfaceContext['theme'] = SURFACE_CONTEXT_THEME_FIXTURE;
export const createSurfaceContext: (overrides?: Partial<SurfaceContext>) => SurfaceContext = createSurfaceContextFixture;

function unsupportedHostMethod(): never {
  throw new PluginError({ code: 'unsupported_method' });
}

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
    publishCurrentUiContext: () => undefined,
    executeAction: async () => unsupportedHostMethod(),
    selectActionInput: async () => ({ kind: 'cancelled' as const }),
    readResource: async () => resource,
    statOpenableContent: async () => unsupportedHostMethod(),
    readOpenableContent: async () => unsupportedHostMethod(),
    watchResource: async () => unsupportedHostMethod(),
    openSurface: async () => undefined,
    replacePageLocation: async () => unsupportedHostMethod(),
    notify: async () => undefined,
    confirm: async () => false,
    diagnostic: () => undefined,
    readClipboard: async () => '',
    writeClipboard: async () => undefined,
    openExternalLink: async () => undefined,
    activeComposer: async () => null,
    readComposer: async () => unsupportedHostMethod(),
    watchComposer: async () => unsupportedHostMethod(),
    applyComposer: async () => unsupportedHostMethod(),
    focusComposer: async () => unsupportedHostMethod(),
    setComposerDecorations: async () => unsupportedHostMethod(),
    acquireComposerInputLock: async () => unsupportedHostMethod(),
    pickComposerMedia: async () => unsupportedHostMethod(),
    inspectComposerContent: async () => unsupportedHostMethod(),
    releaseComposerContent: async () => unsupportedHostMethod(),
    ...overrides,
  } satisfies PluginUiHostApi;
}
