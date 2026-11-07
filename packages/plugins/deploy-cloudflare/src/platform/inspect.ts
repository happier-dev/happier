import type { DeploymentTargetPreparationBaseV1, JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { workersPrepare, workerPrepareInput } from './workersActions.js';
import { pagesPrepare, pagesPrepareInput } from './pagesPrepare.js';

import { targetOptionInputHints, targetProductInputHints } from './targetOptions.js';

/** One discovered Connect / Check again Action; product handlers retain their own preparation. */
export const inspect = {
  ...workersPrepare,
  title: 'Inspect the selected Cloudflare target',
  surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'],
  hostAccess: ['cloudflare-workers', 'cloudflare-pages', 'deploy.manage'],
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: { ...pagesPrepareInput.properties, ...workerPrepareInput.properties },
    required: workerPrepareInput.required,
    anyOf: [workerPrepareInput, pagesPrepareInput],
  },
  inputHints: targetOptionInputHints,
  async run(input: JsonValue, context: PluginAccountActionContext) {
    // Action admission validated the selected product's closed input schema.
    const request = input as unknown as DeploymentTargetPreparationBaseV1;
    return 'scriptName' in request.providerEnvironment
      ? workersPrepare.run(input, context) : pagesPrepare.run(input, context);
  },
} satisfies PluginActionDefinition;

/** Each selected target supplies its product; preparation and provider reads retain their owners. */
export const productInspectActions: Readonly<Record<'workers-inspect' | 'pages-inspect',
  PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>>> = {
  'workers-inspect': { ...workersPrepare, title: 'Inspect the selected Cloudflare Worker',
    surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], inputHints: targetProductInputHints('workers') },
  'pages-inspect': { ...pagesPrepare, title: 'Inspect the selected Cloudflare Pages project',
    surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], inputHints: targetProductInputHints('pages') },
};
