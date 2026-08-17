import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Mount a plugin-ui element through the real React Native Web runtime.
 *
 * SUPPORTING EVIDENCE ONLY (§7). jsdom is excluded from the layer-6 component
 * oracle, so nothing mounted here can close the EU-7 gate; the packed-candidate
 * browser QA and the Maestro device lane do that. This exists so the package's
 * own RED/GREEN loop catches "renders an inert element" defects immediately.
 */
export type RnwMount = Readonly<{
  container: HTMLElement;
  /** Reconciles the next real RNW element into this same host root. */
  render: (element: ReactNode) => Promise<void>;
  unmount: () => void;
}>;

function createRnwMount(container: HTMLElement, root: Root): RnwMount {
  let unmounted = false;

  return {
    container,
    async render(element) {
      if (unmounted) throw new Error('React Native Web test mount is already unmounted.');
      await act(async () => {
        root.render(element);
      });
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function mountThroughReactNativeWeb(element: ReactNode): RnwMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | undefined;

  act(() => {
    root = createRoot(container);
    root.render(element);
  });

  if (!root) throw new Error('React Native Web test root did not mount.');
  return createRnwMount(container, root);
}

export async function mountThroughReactNativeWebAsync(element: ReactNode): Promise<RnwMount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | undefined;

  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });

  if (!root) throw new Error('React Native Web test root did not mount.');
  return createRnwMount(container, root);
}
