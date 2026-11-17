export const PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 = {
  list: 'plugins.collections.shared.list',
  get: 'plugins.collections.shared.get',
  put: 'plugins.collections.shared.put',
  listGrants: 'plugins.collections.shared.grants.list',
  setGrant: 'plugins.collections.shared.grants.set',
  revokeGrant: 'plugins.collections.shared.grants.revoke',
} as const;

export type PluginCollectionSharingActionIdV1 = typeof PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1[keyof typeof PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1];
export const PLUGIN_COLLECTION_SHARING_ACTION_IDS_V1 = Object.values(PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1);
const ids: ReadonlySet<string> = new Set(PLUGIN_COLLECTION_SHARING_ACTION_IDS_V1);
export function isPluginCollectionSharingActionIdV1(value: string): value is PluginCollectionSharingActionIdV1 {
  return ids.has(value);
}
export function isPluginCollectionSharingMutationActionIdV1(value: PluginCollectionSharingActionIdV1): boolean {
  return value === PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1.put
    || value === PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1.setGrant
    || value === PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1.revokeGrant;
}
