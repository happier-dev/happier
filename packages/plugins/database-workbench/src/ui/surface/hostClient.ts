import {
  DATABASE_OPERATION_ACTION_ID_V1,
  DATABASE_TARGETS_LIST_ACTION_ID_V1,
  type DatabaseOperationResultV1,
  type DatabaseTargetsListResultV1,
} from '@happier-dev/database-protocol';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { encodeWorkbenchSubPath } from './subPath.js';
import type { WorkbenchClient } from '../models.js';

type HostOptions = Readonly<{
  /** Page mounts own a location; the services panel has none, so navigation stays local there. */
  pageLocation: boolean;
}>;

/**
 * The renderer's binding of the workbench client to its mount's host API. Reads are ordinary
 * Action invocations; committing effects never pass through here (they are Action.Control bindings).
 */
export function createHostWorkbenchClient(
  hostApi: PluginUiHostApi,
  options: HostOptions,
): WorkbenchClient {
  return {
    async targets(input, signal) {
      const result = await hostApi.executeAction(
        DATABASE_TARGETS_LIST_ACTION_ID_V1,
        projectNativeJsonValueForTransport(input),
        { signal },
      );
      // The SDK admitted the result against the declaration's result schema.
      return result as unknown as DatabaseTargetsListResultV1;
    },
    async operation(input, signal) {
      const result = await hostApi.executeAction(
        DATABASE_OPERATION_ACTION_ID_V1[input.operation],
        projectNativeJsonValueForTransport(input),
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
    // R4 own-write push has no producer yet; a committed Apply invalidates its relation in the instance.
    subscribeOwnWrites() {
      return () => {};
    },
    async navigate(location) {
      if (!options.pageLocation) return;
      await hostApi.replacePageLocation(encodeWorkbenchSubPath(location), {
        preserveUnsavedChanges: true,
      });
    },
    async setUnsavedChanges(value) {
      if (options.pageLocation) await hostApi.setUnsavedChanges(value);
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
