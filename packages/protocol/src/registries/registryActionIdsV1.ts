
/** Action identity leaf: schema modules and the registry share these constants. */
export const REGISTRY_SOURCE_DELETE_ACTION_ID_V1 = 'registries.sources.delete' as const;
export const REGISTRY_ITEMS_LIST_ACTION_ID_V1 = 'registries.items.list' as const;
export const REGISTRY_ACTION_IDS_V1=['registries.sources.list','registries.sources.detect','registries.sources.create',
  'registries.sources.update','registries.sources.token.set',REGISTRY_SOURCE_DELETE_ACTION_ID_V1,REGISTRY_ITEMS_LIST_ACTION_ID_V1,'registries.items.read','registries.updates.check'] as const;
