import type { SurfaceAddress } from './themeSurface.js';

type InspectionListener = (address: SurfaceAddress, host: unknown) => void;
let activeInspection: InspectionListener | null = null;

/** One active, device-local interaction; cleanup never retires a newer owner. */
export function beginThemeSurfaceInspection(listener: InspectionListener): () => void {
  activeInspection = listener;
  return () => { if (activeInspection === listener) activeInspection = null; };
}

/** Native responder bubbling selects the deepest addressed painted host. */
export function createThemeSurfaceInspectionBinding(address: SurfaceAddress) {
  let host: unknown = null;
  return {
    ref: (next: unknown) => { host = next; },
    collapsable: false as const,
    onStartShouldSetResponder: () => {
      if (!activeInspection) return false;
      if (host) activeInspection(address, host);
      return true;
    },
    // The painted View owns the gesture while picking, so an enclosing
    // Pressable never receives the responder release that activates its action.
    onResponderTerminationRequest: () => false,
  };
}
