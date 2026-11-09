import type { PluginClientApi } from '@happier-dev/plugin-sdk';

const installationUrls = {
  docker: 'https://docs.docker.com/engine/install/',
  podman: 'https://podman.io/docs/installation',
} as const;

/** Runtime installation is a host-administrator task; open its official guide
 * on the answering device through the existing prerequisite repair launcher. */
export function activate(api: PluginClientApi): void {
  api.actions.register('runtime-install-docs', async (input, context) => {
    // The host admits this Action's closed input schema before invoking it.
    const { runtime } = input as { runtime: keyof typeof installationUrls };
    if (context.invocationSurface === 'agent' || context.invocationSurface === 'mcp' || context.invocationSurface === 'cli') {
      return { url: installationUrls[runtime] };
    }
    await context.ui.executeAction('links.openExternal', { url: installationUrls[runtime] }, { signal: context.signal });
    return null;
  });
}
