import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import { createForgeCiMountedViewV1, type ForgeCiMountedViewV1 } from './mountedCiIntent.js';

/** The host registers the returned live model in its existing mounted Action owner. */
export function useForgeCiMountedViewV1(options: Omit<Parameters<typeof createForgeCiMountedViewV1>[0], 'mountId'> & Readonly<{ mountId: string | undefined; signal?: AbortSignal }>): ForgeCiMountedViewV1 | null {
  const { active } = usePluginSurfaceActivity();
  const mountedPhone = useRef(options.phone);
  const availability = useRef({ active, canApply: options.canApply, applyOperation: options.applyOperation });
  const [held, setHeld] = useState<Readonly<{ mountId: string; model: ForgeCiMountedViewV1 }> | null>(null);
  useEffect(() => { availability.current = { active, canApply: options.canApply, applyOperation: options.applyOperation }; }, [active, options.canApply, options.applyOperation]);
  useEffect(() => {
    if (!options.mountId || options.signal?.aborted) { setHeld(null); return; }
    const model = createForgeCiMountedViewV1({
      mountId: options.mountId, phone: mountedPhone.current,
      ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
      isAvailable: () => availability.current.active,
      applyOperation: (operation, state) => availability.current.applyOperation?.(operation, state) ?? true,
      canApply: (operation, state) => availability.current.canApply?.(operation, state)
        ?? (operation.kind === 'setJobsView' && operation.view === 'graph' ? false : true),
    });
    const retire = () => { model.dispose(); setHeld(null); };
    options.signal?.addEventListener('abort', retire, { once: true });
    setHeld({ mountId: options.mountId, model });
    return () => { options.signal?.removeEventListener('abort', retire); model.dispose(); };
  }, [options.mountId, options.signal]);
  return held !== null && held.mountId === options.mountId ? held.model : null;
}

const emptySubscription = () => () => {};
const emptySnapshot = () => null;
export function useForgeCiMountedViewStateV1(view: ForgeCiMountedViewV1 | null) {
  return useSyncExternalStore(view?.subscribe ?? emptySubscription, view?.getSnapshot ?? emptySnapshot, view?.getSnapshot ?? emptySnapshot);
}
