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

/**
 * A minimal admissible packaged mark: PNG signature plus a real IHDR.
 *
 * The renderable-image owner reads the declared canvas out of IHDR to bound
 * decode memory, so a bare signature is deliberately NOT admissible. Every test
 * that needs an admitted mark builds one here rather than restating the header
 * layout, and `byteLength` stays divisible by three so an indexed-read counter
 * measures exactly one read per byte per base64 conversion.
 */
export function createAdmittedBrandPngFixture(options?: Readonly<{
  width?: number;
  height?: number;
  byteLength?: number;
  /** Skip admission to model bytes that reached a render without an owner. */
  admit?: boolean;
}>): Uint8Array {
  const width = options?.width ?? 16;
  const height = options?.height ?? 16;
  const byteLength = Math.max(options?.byteLength ?? 27, 27);
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk: its 13-byte length, then the chunk type.
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 24; index < byteLength; index += 1) bytes[index] = index % 251;
  if (options?.admit !== false) materializeHappierRenderableImage(bytes);
  return bytes;
}
