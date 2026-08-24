import { createSurfaceContextFixture, SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';

import { materializeHappierRenderableImage } from './presentation/content/renderableImage.js';
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

/** A complete, decoder-valid 1x1 RGBA PNG used by every positive image fixture. */
const VALID_TRANSPARENT_PNG = Object.freeze([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x09, 0x70, 0x48, 0x59, 0x73, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x4f, 0x25, 0xc4, 0xd6, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x64, 0x00, 0x02, 0x00, 0x00, 0x0a, 0x00,
  0x02, 0x6c, 0x41, 0xb3, 0x42, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

export function createAdmittedBrandPngFixture(options?: Readonly<{
  /** Skip admission to model bytes that reached a render without an owner. */
  admit?: boolean;
}>): Uint8Array {
  const bytes = new Uint8Array(VALID_TRANSPARENT_PNG);
  if (options?.admit !== false) materializeHappierRenderableImage(bytes);
  return bytes;
}
