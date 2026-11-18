import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { DeploymentSuggestionActionInputSchemasV1 as inputs, DeploymentSuggestionActionOutputSchemasV1 as outputs } from '../../deployments/suggestions/actionsV1.js';
import { DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';

const common = {
    executionPlacement: 'account', originalExecution: { accountRoot: 'allowed' },
    approval: { result: 'none' }, safety: 'safe', sideEffectClass: 'read', placements: [],
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
} as const;
export const DEPLOYMENT_SUGGESTION_ACTION_SPECS_V1 = lazyActionSpecArray(() => [{
    ...common, id: DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1, title: 'Read app setup catalog',
    description: 'Read one compact snapshot of current starters, catalog apps, deployment targets, connected accounts and Machines. Reuse it while answering questions; read again after connecting an account.',
    bindings: { mcpToolName: 'deployments_suggestions_catalog' },
    inputSchema: inputs[DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1], outputSchema: outputs[DEPLOYMENT_SUGGESTIONS_CATALOG_ACTION_ID_V1],
    inputHints: { fields: [] }, cli: { acceptsServerId: true, commands: [{ path: ['deployments', 'suggestions', 'catalog'], visibility: 'canonical' }] },
}, {
    ...common, id: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1, title: 'Check app setup suggestions',
    description: 'Validate suggested setups against the exact catalog snapshot already read. Returns surviving recommendations and drop reasons without any fresh reads. Present actionable setup cards from this result.',
    bindings: { mcpToolName: 'deployments_suggestions_check' },
    inputSchema: inputs[DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1], outputSchema: outputs[DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1],
    inputHints: { fields: [{ path: 'catalog', title: 'Held catalog snapshot', widget: 'json', required: true },
        { path: 'suggestion', title: 'Suggested setups', widget: 'json', required: true },
        { path: 'description', title: 'The person\u2019s description, unchanged', widget: 'textarea', required: false }] },
    cli: { acceptsServerId: true, commands: [{ path: ['deployments', 'suggestions', 'check'], visibility: 'canonical' }] },
}] as const satisfies readonly PreNormalizedActionSpec[]);
