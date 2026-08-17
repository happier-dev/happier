import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

import {
  useOptionalPluginUiPresentationHost,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';

/**
 * An author-held logical target for one public component. It has no physical
 * node, navigation state, or platform branch: the mounted host decides whether
 * a transfer is current and performs it on the bound native or web control.
 */
export type PluginUiFocusTarget = Readonly<{
  focus(): boolean;
}>;

type FocusBinding = Readonly<{
  host: PluginUiPresentationHost;
  target: unknown;
}>;

type FocusBindingRef = { current: FocusBinding | null };

const focusTargetBindings = new WeakMap<PluginUiFocusTarget, FocusBindingRef>();

function readFocusBindingRef(target: PluginUiFocusTarget | undefined): FocusBindingRef | undefined {
  return target === undefined ? undefined : focusTargetBindings.get(target);
}

/**
 * Create one stable logical focus target. Pass it to a public focusable
 * primitive's `focusTarget` prop, then call `focus()` after an author-owned
 * state transition. A target without a live mounted host returns `false`.
 */
export function usePluginUiFocusTarget(): PluginUiFocusTarget {
  const bindingRef = useRef<FocusBinding | null>(null);

  return useMemo<PluginUiFocusTarget>(() => {
    const target = Object.freeze({
      focus(): boolean {
        const binding = bindingRef.current;
        return binding?.host.focusTarget?.(binding.target) === true;
      },
    });
    focusTargetBindings.set(target, bindingRef);
    return target;
  }, []);
}

function clearFocusBinding(
  targetBindingRef: FocusBindingRef | undefined,
  ownedBindingRef: FocusBindingRef,
): void {
  const binding = ownedBindingRef.current;
  if (binding && targetBindingRef?.current === binding) {
    targetBindingRef.current = null;
  }
  ownedBindingRef.current = null;
}

/**
 * Package-internal adapter for public primitives. The module-private binding
 * association holds only the current physical target; it is intentionally not a
 * navigation/focus registry, controller, or persistence owner.
 */
export function usePluginUiFocusTargetBindingInternal(
  focusTarget: PluginUiFocusTarget | undefined,
): ((target: unknown | null) => void) | undefined {
  const presentationHost = useOptionalPluginUiPresentationHost();
  const targetBindingRef = readFocusBindingRef(focusTarget);
  const ownedBindingRef = useRef<FocusBinding | null>(null);
  const clear = useCallback(() => {
    clearFocusBinding(targetBindingRef, ownedBindingRef);
  }, [targetBindingRef]);
  const bind = useCallback((target: unknown | null) => {
    clear();
    if (targetBindingRef === undefined || target === null || presentationHost?.focusTarget === undefined) return;
    const binding = Object.freeze({ host: presentationHost, target });
    ownedBindingRef.current = binding;
    targetBindingRef.current = binding;
  }, [clear, presentationHost, targetBindingRef]);

  useLayoutEffect(() => clear, [clear]);
  return targetBindingRef === undefined ? undefined : bind;
}
