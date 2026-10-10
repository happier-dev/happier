import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { useFindSurfaceRegistrationWithHost, type FindSurfaceRegistration } from '../presentation/find/useFindSurfaceRegistration.js';

/** Join the mounted host's Find keyboard and ui.find Action owner; no second matcher or registry. */
export function useFindSurfaceRegistration(surface: FindSurfaceRegistration | null): boolean {
  const host = useOptionalPluginUiPresentationHost()?.find ?? null;
  useFindSurfaceRegistrationWithHost(surface, host);
  return host !== null;
}
export type { FindSurfaceRegistration } from '../presentation/find/useFindSurfaceRegistration.js';
