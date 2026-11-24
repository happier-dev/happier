import {
    DATABASE_ACCESS_READ_ACTION_ID_V1,
    DATABASE_CONNECTION_RESOURCE_ID_V1,
    DATABASE_PLUGIN_ID_V1,
    DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1,
    DatabaseDemandSnapshotV1Schema,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
    type DatabaseDemandSnapshotV1,
} from '@happier-dev/database-protocol';
import {
    type DatabaseAccessReadResultV1,
    type DatabaseDescriptorV1,
    type DatabaseOperationResultV1,
    type DatabaseTargetV1,
    type DatabaseTargetsListResultV1,
} from '@happier-dev/plugin-sdk/database';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { encodeWorkbenchRootSubPath, encodeWorkbenchSubPath } from './subPath.js';
import type { WorkbenchClient } from '../models.js';
import { databaseOperationActions } from '../../operationActions.js';
import { workbenchTargetKey } from '../../targetIdentity.js';

type HostOptions = Readonly<{
  /** Page mounts own a location; the services panel has none, so navigation stays local there. */
  pageLocation: boolean;
  pageTarget?: DatabaseTargetV1;
}>;

/**
 * The renderer borrows its mounted Resource's connection demand for read Actions.
 * Committing effects use Action.Control bindings and publish through that same Resource owner.
 */
export function createHostWorkbenchClient(
  hostApi: PluginUiHostApi,
  options: HostOptions,
): WorkbenchClient & Readonly<{
  describe(target: DatabaseTargetV1, signal: AbortSignal): Promise<Readonly<{
    descriptor: DatabaseDescriptorV1; connection: 'watch' | 'standalone';
  }>>;
  dispose(): void;
}> {
  const listeners = new Set<Parameters<WorkbenchClient['subscribeOwnWrites']>[0]>();
  const demands = new Map<string, Readonly<{ ready: Promise<DatabaseDemandSnapshotV1 | null>; subscriptionId(): string; dispose(): void }>>();
  function demand(target: DatabaseTargetV1) {
    const targetKey = workbenchTargetKey(target);
    const held = demands.get(targetKey);
    if (held) return held;
    const input = projectNativeJsonValueForTransport({ operation: 'describe', target });
    let subscriptionId: string;
    let previous: DatabaseDemandSnapshotV1 | undefined;
    let resolveReady!: (snapshot: DatabaseDemandSnapshotV1 | null) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<DatabaseDemandSnapshotV1 | null>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let admission: ReturnType<PluginUiHostApi['watchResource']>;
    const store = createPluginUiResourceStore({ client: {
      watchResource(resource, listener, requestOptions) {
        const selected = { ...requestOptions, input };
        admission = hostApi.watchResource(resource, listener, selected).then(handle => {
          subscriptionId = handle.subscriptionId;
          changed();
          return handle;
        }, error => {
          if ('environment' in target && isPluginError(error)
            && (error.code === 'plugin_resource_transport_unavailable' || error.code === 'plugin_resource_transport_not_supported')) {
            // The watch could not be established. The Action relay still admits every standalone request.
            resolveReady(null);
          } else {
            rejectReady(error);
          }
          throw error;
        });
        return admission;
      },
      async readResource(resource, requestOptions) {
        // Snapshot and invoke use the same admitted producer, including its selected target.
        await admission;
        const selected = { ...requestOptions, input };
        return await hostApi.readResource(resource, selected);
      },
    } });
    const selected = store.getEntry(DATABASE_CONNECTION_RESOURCE_ID_V1).select({
      decode(content) {
        return DatabaseDemandSnapshotV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
      },
    }, snapshot => snapshot);
    function changed() {
      const snapshot = selected.getSnapshot();
      if (snapshot.error) rejectReady(new PluginError({ code: snapshot.error.code ?? 'action_failed',
        message: snapshot.error.message, retryable: snapshot.error.retryable, details: snapshot.error.details }));
      const next = snapshot.value;
      if (!next || next === previous) return;
      const before = previous;
      previous = next;
      if (subscriptionId) resolveReady(next);
      if (!before) return;
      if (before.ownWriteRevision !== next.ownWriteRevision) {
        for (const listener of listeners) listener({ target });
        return;
      }
      const revisions = new Map(before.relationRevisions.map(item => [JSON.stringify(item.relation), item]));
      for (const item of next.relationRevisions) {
        const relationKey = JSON.stringify(item.relation);
        if (revisions.get(relationKey)?.revision !== item.revision) {
          for (const listener of listeners) listener({ target, relation: item.relation });
        }
        revisions.delete(relationKey);
      }
      for (const item of revisions.values()) {
        for (const listener of listeners) listener({ target, relation: item.relation });
      }
    }
    const unsubscribe = selected.subscribe(changed, true);
    const value = { ready, subscriptionId: () => subscriptionId, dispose() {
      rejectReady(new DOMException('The database connection demand was released', 'AbortError'));
      unsubscribe();
      store.dispose();
    } };
    demands.set(targetKey, value);
    return value;
  }
  function dispose() {
    for (const held of demands.values()) held.dispose();
    demands.clear();
  }
  async function executeOperation(input: Parameters<WorkbenchClient['operation']>[0], signal: AbortSignal, subscriptionId?: string) {
    signal.throwIfAborted();
    const result = await hostApi.executeAction(
      databaseActionLocalIdV1(databaseOperationActions[input.operation].id),
      projectNativeJsonValueForTransport(subscriptionId === undefined ? input : { ...input, subscriptionId }),
      { signal },
    );
    // The SDK admitted the result against DatabaseOperationResultV1ProtocolSchema.
    return result as unknown as DatabaseOperationResultV1;
  }
  return {
    dispose,
    releaseReadDemand(target) {
      const targetKey = workbenchTargetKey(target);
      const held = demands.get(targetKey);
      demands.delete(targetKey);
      held?.dispose();
    },
    async describe(target, signal) {
      const snapshot = await demand(target).ready;
      signal.throwIfAborted();
      if (snapshot) return { descriptor: snapshot.descriptor, connection: 'watch' };
      const result = await executeOperation({ operation: 'describe', target }, signal);
      if (!result.ok) throw new PluginError({ code: result.code });
      if (result.operation !== 'describe') throw new PluginError({ code: 'plugin_resource_result_invalid' });
      return { descriptor: result.descriptor, connection: 'standalone' };
    },
    machineDisplayName: (request, options) => hostApi.readMachineDisplayName(request, options),
    async targets(input, signal) {
      const result = await hostApi.executeAction(
        databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1),
        projectNativeJsonValueForTransport(input),
        { signal },
      );
      // The SDK admitted the result against the declaration's result schema.
      return result as unknown as DatabaseTargetsListResultV1;
    },
    async operation(input, signal) {
      const held = demand(input.target);
      const snapshot = await held.ready;
      return executeOperation(input, signal, snapshot ? held.subscriptionId() : undefined);
    },
    async access(target, signal) {
      const result = await hostApi.executeAction(
        databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1),
        projectNativeJsonValueForTransport({ target }),
        { signal },
      );
      // The SDK admitted the result against the declared access-result union.
      return result as unknown as DatabaseAccessReadResultV1;
    },
    subscribeOwnWrites(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        dispose();
      };
    },
    async navigate(location, signal) {
      if (!options.pageLocation) return;
      await hostApi.replacePageLocation(encodeWorkbenchSubPath(location, options.pageTarget), {
        // Every place goes back to the database's root, which a phone shows as the rail (lab tablesp).
        backLocation: encodeWorkbenchRootSubPath(options.pageTarget),
        preserveUnsavedChanges: true,
        ...(signal ? { signal } : {}),
      });
    },
    async openRoot() {
      if (!options.pageLocation) return;
      await hostApi.replacePageLocation(encodeWorkbenchRootSubPath(options.pageTarget), { preserveUnsavedChanges: true });
    },
    async setUnsavedChanges(value) {
      await hostApi.setUnsavedChanges(value);
    },
    async saveExport(input, signal) {
      return await hostApi.downloadFile(
        {
          action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1) },
          // The serializer input is one object; its rows project member by member for transport.
          input: { format: input.format, result: projectNativeJsonValueForTransport(input.result) },
        },
        signal ? { signal } : undefined,
      );
    },
    presentDeviceStorageError(error) {
      void hostApi.notify(
        error instanceof Error
          ? error.message
          : 'Console history could not be saved on this device',
        { severity: 'error' },
      );
    },
  };
}
