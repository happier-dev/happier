import type { BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';

/**
 * Background work is daemon-generation scoped. The host starts this runner
 * after committing the generation and retires it on replacement, uninstall,
 * or daemon shutdown.
 */
export const refreshCatalogInBackground: BackgroundServiceRunner = async (context) => {
    context.signal.throwIfAborted();
    // Fetch or refresh bounded data through context.services, then exit or
    // wait on the supplied signal. This compile reference does no real work.
};
