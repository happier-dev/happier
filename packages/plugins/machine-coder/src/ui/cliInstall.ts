import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { CODER_CLI_INSTALL_ACTION, CODER_CLI_INSTALL_DOCS_URL } from '../machine/cliPrerequisite.js';

/** Installation belongs to the controller administrator; reuse the host link Action. */
export function activate(api: PluginClientApi): void {
  api.actions.register(CODER_CLI_INSTALL_ACTION, async (_input, context) => {
    if (context.invocationSurface === 'agent' || context.invocationSurface === 'mcp' || context.invocationSurface === 'cli') {
      return { url: CODER_CLI_INSTALL_DOCS_URL };
    }
    await context.ui.executeAction('links.openExternal', { url: CODER_CLI_INSTALL_DOCS_URL }, { signal: context.signal });
    return null;
  });
}
