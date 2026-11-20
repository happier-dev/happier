import { DeploymentTargetPreparationBaseV1ProtocolSchema, type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { workersPrepare, workerPrepareInput, workerLinkSchema } from './workersActions.js';
import { pagesPrepare, pagesPrepareInput, pagesLinkSchema } from './pagesPrepare.js';

import { targetOptionInputHints, targetProductInputHints } from './targetOptions.js';
import { cloudflareReviewNotice } from './reviewNotice.js';
import { CLOUDFLARE_BUILD_IMAGE_PIN, CLOUDFLARE_BUILD_NODE_VERSION, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareToolchain.js';

const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema;
const noticeResult: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { preparedNative: { type: 'object', additionalProperties: false,
    properties: {
      reviewNotice: { type: 'string' },
      buildRuntime: { type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, version: { type: 'string' }, pin: { type: 'string' },
          tool: { type: 'string' }, toolVersion: { type: 'string' } },
        required: ['name', 'version', 'pin', 'tool', 'toolVersion'] },
    }, required: ['reviewNotice'] } }, required: ['preparedNative'] };

/** Draft inspection describes consequences, without claiming a resource exists. */
function withPreCreateNotice(action: typeof workersPrepare & { inputSchema: PluginJsonSchema; resultSchema: PluginJsonSchema }, product?: 'workers' | 'pages') {
  const draft: PluginJsonSchema = { type: 'object', additionalProperties: false, properties: {
    ...Object.fromEntries((base.required ?? []).map(key => [key, base.properties![key]!])),
    sourceMethod: base.properties!.sourceMethod!,
    product: product ? { const: product } : { type: 'string', enum: ['workers', 'pages'] },
  }, required: [...base.required ?? [], 'sourceMethod', ...(product ? [] : ['product'])] };
  return { ...action,
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { ...action.inputSchema.properties, ...draft.properties }, required: base.required,
      anyOf: [action.inputSchema, draft] } satisfies PluginJsonSchema,
    resultSchema: { anyOf: [action.resultSchema, noticeResult] } satisfies PluginJsonSchema,
    async run(input: JsonValue, context: PluginAccountActionContext) {
      // Admission distinguishes a source-choice draft from an existing-resource input: the draft names no account
      // (native coordinates) and no identity.
      const request = input as unknown as DeploymentTargetPreparationBaseV1 & { product: 'workers' | 'pages' };
      if (!request.providerIdentity && !request.providerAccountId) {
        const target = product ?? request.product;
        const sourceMethod = request.sourceMethod!;
        return { preparedNative: {
          reviewNotice: cloudflareReviewNotice(target, sourceMethod),
          ...(target === 'pages' && sourceMethod === 'upload' ? { buildRuntime: {
            name: 'Node.js', version: CLOUDFLARE_BUILD_NODE_VERSION, pin: CLOUDFLARE_BUILD_IMAGE_PIN,
            tool: 'Wrangler', toolVersion: CLOUDFLARE_WRANGLER_VERSION,
          } } : {}),
        } };
      }
      return action.run(input, context);
    },
  };
}

/** One discovered Connect / Check again Action; product handlers retain their own preparation. */
export const inspect = withPreCreateNotice({
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
  resultSchema: workerLinkSchema,
  inputHints: targetOptionInputHints,
  async run(input: JsonValue, context: PluginAccountActionContext) {
    // Action admission validated the selected product's closed input schema.
    const request = input as unknown as DeploymentTargetPreparationBaseV1;
    return 'scriptName' in request.providerEnvironment
      ? workersPrepare.run(input, context) : pagesPrepare.run(input, context);
  },
} satisfies typeof workersPrepare);

/** Each selected target supplies its product; preparation and provider reads retain their owners. */
export const productInspectActions: Readonly<Record<'workers-inspect' | 'pages-inspect',
  PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>>> = {
  'workers-inspect': withPreCreateNotice({ ...workersPrepare, title: 'Inspect the selected Cloudflare Worker',
    inputSchema: workerPrepareInput, resultSchema: workerLinkSchema,
    surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], inputHints: targetProductInputHints('workers') }, 'workers'),
  'pages-inspect': withPreCreateNotice({ ...pagesPrepare, title: 'Inspect the selected Cloudflare Pages project',
    inputSchema: pagesPrepareInput, resultSchema: pagesLinkSchema,
    surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], inputHints: targetProductInputHints('pages') }, 'pages'),
};
