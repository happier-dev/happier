import * as React from 'react';

export type FlashListCompatComponent = React.ComponentType<any>;

export type FlashListRuntimeResolution = Readonly<{
  Component: FlashListCompatComponent;
  usingFallback: boolean;
  reason: 'flashlist_unavailable' | null;
}>;

const DefaultFallbackFlashList = React.forwardRef(function DefaultFallbackFlashList(_props: Record<string, unknown>, _ref: React.ForwardedRef<unknown>) {
  return null;
}) as FlashListCompatComponent;

export function resolveFlashListRuntime(loadModule: () => unknown, fallbackComponent: FlashListCompatComponent = DefaultFallbackFlashList): FlashListRuntimeResolution {
  try {
    const loaded = loadModule() as { FlashList?: React.ComponentType<any> } | null | undefined;
    const Component = loaded?.FlashList;
    if (Component) {
      return {
        Component,
        usingFallback: false,
        reason: null,
      };
    }
  } catch {
    // Fall through to the compat fallback below.
  }

  return {
    Component: fallbackComponent,
    usingFallback: true,
    reason: 'flashlist_unavailable',
  };
}
