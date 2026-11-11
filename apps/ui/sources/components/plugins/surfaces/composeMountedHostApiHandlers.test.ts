import { describe, expect, it, vi } from 'vitest';

import type { BoundPluginSurfaceMountedHostApiHandlersFactory } from './boundPluginSurfaceController';
import { composeMountedHostApiHandlerFactories } from './composeMountedHostApiHandlers';

// Live 2026-11-11 (Account B): a Session details tab supplied a mounted `settleEphemeralInput`, but every mounted
// destination also owns a Composer, and the Composer's handler factory replaced the placement's, so the plugin saw
// `host_api_method_not_installed:settleEphemeralInput`. One physical mount composes every owner's handlers.
describe('composeMountedHostApiHandlerFactories', () => {
  const settle = vi.fn(() => null);
  const notify = vi.fn(() => null);
  const placement: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({
    handlers: { settleEphemeralInput: settle, notify },
    dispose: placementDispose,
  });
  const placementDispose = vi.fn();
  const composerNotify = vi.fn(() => null);
  const composerDispose = vi.fn();
  const composer: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({
    handlers: { readComposer: vi.fn(() => null), notify: composerNotify },
    dispose: composerDispose,
  });

  it('keeps the placement handlers beside the Composer handlers, the later owner deciding a shared method', () => {
    const composed = composeMountedHostApiHandlerFactories(placement, composer);
    const bundle = composed?.({ isCurrent: () => true });
    expect(bundle?.handlers.settleEphemeralInput).toBe(settle);
    expect(bundle?.handlers.readComposer).toBeTypeOf('function');
    expect(bundle?.handlers.notify).toBe(composerNotify);
    bundle?.dispose?.();
    expect(placementDispose).toHaveBeenCalledTimes(1);
    expect(composerDispose).toHaveBeenCalledTimes(1);
  });

  it('passes one owner through unchanged and has nothing to compose without any', () => {
    expect(composeMountedHostApiHandlerFactories(undefined, composer)).toBe(
      composer,
    );
    expect(composeMountedHostApiHandlerFactories(placement, undefined)).toBe(
      placement,
    );
    expect(
      composeMountedHostApiHandlerFactories(undefined, undefined),
    ).toBeUndefined();
  });
});
