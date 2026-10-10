import { useEffect, useRef } from 'react';
import type { FindController } from './findTypes.js';

/** A mounted display model; matching, reveal and focus remain surface-owned. */
export type FindSurfaceRegistration = Readonly<{
  surfaceId: string;
  containsFocus(): boolean;
  open(): void;
  isOpen(): boolean;
  isInputFocused(): boolean;
  isAvailable?(): boolean;
  engineOwnsFind?: boolean;
  controller: FindController;
}>;

/** Host adapter onto the incumbent keyboard/Action registry, never a second registry. */
export type FindSurfaceRegistrationHost = Readonly<{
  register(surface: FindSurfaceRegistration): () => void;
  refresh(): void;
}>;

/** Host composition uses the same hook without requiring a plugin mount. */
export function useFindSurfaceRegistrationWithHost(surface: FindSurfaceRegistration | null, host: FindSurfaceRegistrationHost | null): void {
  const latest = useRef(surface);
  latest.current = surface;
  const surfaceId = surface?.surfaceId;
  useEffect(() => {
    if (!host || surfaceId === undefined) return;
    const dispose = host.register({
      surfaceId,
      containsFocus: () => latest.current?.containsFocus() === true,
      isAvailable: () => latest.current !== null && latest.current.isAvailable?.() !== false,
      open: () => latest.current?.open(),
      isOpen: () => latest.current?.isOpen() === true,
      isInputFocused: () => latest.current?.isInputFocused() === true,
      get engineOwnsFind() { return latest.current?.engineOwnsFind === true; },
      get controller() { return latest.current!.controller; },
    });
    host.refresh();
    return () => { dispose(); host.refresh(); };
  }, [host, surfaceId]);
  const focused = surface?.containsFocus() === true;
  const open = surface?.isOpen() === true;
  const inputFocused = surface?.isInputFocused() === true;
  const available = surface !== null && surface.isAvailable?.() !== false;
  useEffect(() => { host?.refresh(); }, [host, focused, open, inputFocused, available]);
}
