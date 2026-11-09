import type { PluginClientApi } from '@happier-dev/plugin-sdk';

export const DOCKER_SANDBOXES_INSTALL_URL = 'https://docs.docker.com/ai/sandboxes/install/';

/** Open installation instructions on the answering device through the ordinary host Action. */
export function activate(api: PluginClientApi): void {
  api.actions.register('install-docs', async (_input, context) => {
    await context.ui.executeAction('links.openExternal', { url: DOCKER_SANDBOXES_INSTALL_URL }, { signal: context.signal });
    return null;
  });
}
