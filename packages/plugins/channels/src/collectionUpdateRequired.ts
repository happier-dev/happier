import { isPluginError, type PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition, PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

/** Content-free status shared by supervisor diagnostics and connections-v1. */
export type ChannelsCollectionUpdateRequired = Readonly<{
  kind: 'updateRequired';
  code: 'collection_update_required';
  collectionId: string;
  retryable: false;
  recovery: 'updateHappierOnThisMachine';
}>;

/**
 * One admitted invocation's Collection access. A refused compiled contract
 * cannot be repaired by a row hint or a retry deadline. Settle it here, before
 * recovery adapters can collapse the typed refusal into ordinary unavailability.
 * Subsequent work (including writes) stays inert; a new activation binds fresh
 * access. This is neither a contract resolver nor a stored availability copy.
 */
export function createChannelsCollectionAccess(
  account: PluginAccountStorageScope,
  onUpdateRequired?: (status: ChannelsCollectionUpdateRequired, error: PluginError) => void,
) {
  let refusal: Readonly<{ status: ChannelsCollectionUpdateRequired; error: PluginError }> | undefined;
  const invoke = async <T>(collectionId: string, operation: () => Promise<T>): Promise<T> => {
    if (refusal !== undefined) throw refusal.error;
    try {
      return await operation();
    } catch (error) {
      if (refusal === undefined && isPluginError(error) && error.code === 'collection_update_required') {
        const status: ChannelsCollectionUpdateRequired = Object.freeze({
          kind: 'updateRequired', code: 'collection_update_required', collectionId,
          retryable: false, recovery: 'updateHappierOnThisMachine',
        });
        refusal = { status, error };
        onUpdateRequired?.(status, error);
      }
      throw error;
    }
  };
  const storage: PluginAccountStorageScope = {
    kv: account.kv,
    collection<TDefinition extends PluginAccountCollectionDefinition>(
      definition: TDefinition,
    ): PluginAccountCollectionForDefinition<TDefinition> {
      const collection = account.collection(definition);
      return {
        sharing: collection.sharing,
        get: (rowId, options) => invoke(definition.id, () => collection.get(rowId, options)),
        query: (query, options) => invoke(definition.id, () => collection.query(query, options)),
        put: (value, options) => invoke(definition.id, () => collection.put(value, options)),
        delete: (rowId, options) => invoke(definition.id, () => collection.delete(rowId, options)),
        batch: (operations, options) => invoke(definition.id, () => collection.batch(operations, options)),
        forget: (rowId, options) => invoke(definition.id, () => collection.forget(rowId, options)),
        identityTag: (request, options) => invoke(definition.id, () => collection.identityTag(request, options)),
        limits: options => invoke(definition.id, () => collection.limits(options)),
        measureBatch: (operations, options) => invoke(definition.id, () => collection.measureBatch(operations, options)),
        watch: (query, listener) => refusal === undefined
          ? collection.watch(query, listener) : { dispose() {} },
      };
    },
  };
  return { storage, get updateRequired() { return refusal?.status; } };
}
