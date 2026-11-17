import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_V1, PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as ids,
  isPluginCollectionSharingMutationActionIdV1 } from '../../plugins/data/collectionSharingActionIdsV1.js';
import { PluginCollectionSharingActionInputSchemasV1 as inputs, PluginCollectionSharingActionOutputSchemasV1 as outputs } from '../../plugins/data/collectionSharingActionsV1.js';

const titles = {
  [ids.list]: 'List shared Collection items', [ids.get]: 'Read a shared Collection item',
  [ids.put]: 'Edit a shared Collection item', [ids.listGrants]: 'List Collection item sharing',
  [ids.setGrant]: 'Share a Collection item', [ids.revokeGrant]: 'Remove Collection item sharing',
};

export const PLUGIN_COLLECTION_SHARING_ACTION_SPECS_V1: readonly PreNormalizedActionSpec[] = lazyActionSpecArray(() =>
  PLUGIN_COLLECTION_SHARING_ACTION_IDS_V1.map(id => {
    const mutation = isPluginCollectionSharingMutationActionIdV1(id);
    return {
      id, title: titles[id], description: 'Read or edit logical contributed Collection rows and manage their sharing through the answering client’s Account-bound Collection owner.',
      approval: { result: 'required' }, safety: mutation ? 'danger' : 'safe', sideEffectClass: mutation ? 'write' : 'read',
      ...(mutation ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
      requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
      // All six operations resolve the incumbent Account-mode-aware client.
      requesterAccountContentDemandForInput: () => true,
      surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false },
      bindings: { mcpToolName: id.replaceAll('.', '_') },
      cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
      inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { fields: [] },
    } satisfies PreNormalizedActionSpec;
  }));
