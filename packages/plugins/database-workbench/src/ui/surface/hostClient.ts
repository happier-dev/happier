import {
    DATABASE_CONNECTION_RESOURCE_ID_V1,
    DATABASE_PLUGIN_ID_V1,
    DATABASE_ROWS_EXPORT_DOWNLOAD_ACTION_ID_V1,
    DatabaseDemandSnapshotV1Schema,
    DATABASE_OPERATION_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
    type DatabaseDemandSnapshotV1,
} from '@happier-dev/database-protocol';
import {
    type DatabaseDescriptorV1,
    type DatabaseOperationResultV1,
    type DatabaseTargetV1,
    type DatabaseTargetsListResultV1,
} from '@happier-dev/plugin-sdk/database';
import { PluginError } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { encodeWorkbenchSubPath } from './subPath.js';
import type { WorkbenchClient } from '../models.js';

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
  describe(target: DatabaseTargetV1): Promise<DatabaseDescriptorV1>;
  dispose(): void;
}> {
  const listeners = new Set<Parameters<WorkbenchClient['subscribeOwnWrites']>[0]>();
  const demands = new Map<string, Readonly<{ ready: Promise<DatabaseDemandSnapshotV1>; subscriptionId(): string; dispose(): void }>>();
  function demand(target: DatabaseTargetV1) {
    const targetKey = JSON.stringify(target);
    const held = demands.get(targetKey);
    if (held) return held;
    const input = projectNativeJsonValueForTransport({ operation: 'describe', target });
    let subscriptionId: string;
    let previous: DatabaseDemandSnapshotV1 | undefined;
    let resolveReady!: (snapshot: DatabaseDemandSnapshotV1) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<DatabaseDemandSnapshotV1>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let admission: ReturnType<PluginUiHostApi['watchResource']>;
    const store = createPluginUiResourceStore({ client: {
      watchResource(resource, listener, requestOptions) {
        const selected = { ...requestOptions, input };
        admission = hostApi.watchResource(resource, listener, selected).then(handle => {
          subscriptionId = handle.subscriptionId;
          changed();
          return handle;
        }, error => { rejectReady(error); throw error; });
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
    const value = { ready, subscriptionId: () => subscriptionId, dispose() { unsubscribe(); store.dispose(); } };
    demands.set(targetKey, value);
    return value;
  }
  function dispose() {
    for (const held of demands.values()) held.dispose();
    demands.clear();
  }
  return {
    dispose,
    async describe(target) {
      return (await demand(target).ready).descriptor;
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
      await held.ready;
      signal.throwIfAborted();
      const result = await hostApi.executeAction(
        databaseActionLocalIdV1(DATABASE_OPERATION_ACTION_ID_V1[input.operation]),
        projectNativeJsonValueForTransport({ ...input, subscriptionId: held.subscriptionId() }),
        { signal },
      );
      // The SDK admitted the result against DatabaseOperationResultV1ProtocolSchema.
      return result as unknown as DatabaseOperationResultV1;
    },
    // The access read producer (P3 database.access.read) has not landed; the rail reads the
    // describe-time summary carried by the selected descriptor instead of guessing a level.
    async access() {
      throw new Error('Database access details are not available yet');
    },
    subscribeOwnWrites(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        dispose();
      };
    },
    async navigate(location) {
      if (!options.pageLocation) return;
      await hostApi.replacePageLocation(encodeWorkbenchSubPath(location, options.pageTarget), {
        preserveUnsavedChanges: true,
      });
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
