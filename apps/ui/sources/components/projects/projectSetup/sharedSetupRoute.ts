/**
 * The one route request that carries "Use for this project" into a checkout's Scripts page: the
 * Source whose shared setup the person asked to review there. A request, never an accepted choice.
 */
export const PROJECT_USE_SHARED_SETUP_PARAM = 'useSharedSetup';

/** An Open route's continuation: the same request, carried through Open to the checkout it opens. */
export const PROJECT_OPEN_SHARED_SETUP_PARAM = 'sharedSetupSourceId';

export function readProjectOpenSharedSetupSourceId(params: Readonly<Record<string, string | string[] | undefined>>): string | null {
  const raw = params[PROJECT_OPEN_SHARED_SETUP_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value : null;
}
