import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';

import {
  useOptionalPluginUiPresentationHost,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import type { HappierFocusable } from '../presentation/portableTypes.js';

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
  target: HappierFocusable;
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
): ((target: HappierFocusable | null) => void) | undefined {
  const presentationHost = useOptionalPluginUiPresentationHost();
  const targetBindingRef = readFocusBindingRef(focusTarget);
  const ownedBindingRef = useRef<FocusBinding | null>(null);
  const clear = useCallback(() => {
    clearFocusBinding(targetBindingRef, ownedBindingRef);
  }, [targetBindingRef]);
  const bind = useCallback((target: HappierFocusable | null) => {
    clear();
    if (targetBindingRef === undefined || target === null || presentationHost?.focusTarget === undefined) return;
    const binding = Object.freeze({ host: presentationHost, target });
    ownedBindingRef.current = binding;
    targetBindingRef.current = binding;
  }, [clear, presentationHost, targetBindingRef]);

  useLayoutEffect(() => clear, [clear]);
  return targetBindingRef === undefined ? undefined : bind;
}

type DetailHeadingFocus = Readonly<{
  bindHeading(owner: object, node: HappierFocusable | null): void;
  focus(): void;
}>;

/** Collection's semantic heading scope. The public target and mounted host still own the transfer/announcement. */
export const CollectionDetailHeadingFocusContext = createContext<DetailHeadingFocus | null>(null);

export function useCollectionDetailHeadingFocusInternal(openKey: string | null): DetailHeadingFocus | null {
  const target = usePluginUiFocusTarget();
  const binding = usePluginUiFocusTargetBindingInternal(target);
  const state = useMemo<{ owner: object | null; pending: boolean }>(() => ({ owner: null, pending: true }), [openKey]);
  const scope = useMemo<DetailHeadingFocus | null>(() => {
    if (openKey === null) return null;
    const focus = () => { if (state.pending && target.focus()) state.pending = false; };
    return {
      focus,
      bindHeading(candidate, node) {
        if (node === null) {
          if (state.owner === candidate) { state.owner = null; binding?.(null); }
          return;
        }
        // The entry heading is first in semantic reading order, not a later subsection title.
        if (state.owner !== null && state.owner !== candidate) return;
        state.owner = candidate;
        binding?.(node);
        focus();
      },
    };
  }, [binding, openKey, state, target]);
  useLayoutEffect(() => { scope?.focus(); }, [scope]);
  return scope;
}

export function useCollectionDetailHeadingBindingInternal(explicitTarget?: PluginUiFocusTarget) {
  const explicitBinding = usePluginUiFocusTargetBindingInternal(explicitTarget);
  const scope = useContext(CollectionDetailHeadingFocusContext);
  const owner = useMemo(() => ({}), []);
  const bind = useCallback((node: HappierFocusable | null) => {
    explicitBinding?.(node);
    scope?.bindHeading(owner, node);
  }, [explicitBinding, owner, scope]);
  return explicitBinding === undefined && scope === null ? undefined : bind;
}
