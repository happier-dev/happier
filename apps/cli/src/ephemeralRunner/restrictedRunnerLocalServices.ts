import type {
  DaemonLocalServicePreviewOpenOrCreateRequestV1,
  DaemonLocalServicePreviewRevokeRequestV1,
  DaemonLocalServicePublicPreviewCopyUrlRequestV1,
  DaemonLocalServicePublicPreviewCreateRequestV1,
  DaemonLocalServicePublicPreviewRevokeRequestV1,
  DaemonLocalServicePublicPreviewStatusRequestV1,
  LocalServicePreviewSnapshotV1,
} from '@happier-dev/protocol';

import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { localServiceInventoryEntryMatchesWorkspaceScope } from '@/daemon/local/services/launch/suggestions';
import type { LocalServicePublicPreviewRoutes } from '@/daemon/local/services/public/routes';
import { PluginError } from '@happier-dev/plugin-sdk';
import { PLUGIN_SERVICE_UNAVAILABLE_CODE } from '@/plugins/runtime/invocation/services/unavailable';

function scopeMismatch(): never {
  throw new Error('runner_local_services_scope_mismatch');
}

function requireExactTarget(
  request: Readonly<{ machineId: string; sessionId?: string }>,
  expected: Readonly<{ machineId: string; sessionId: string }>,
): void {
  if (request.machineId !== expected.machineId || request.sessionId !== expected.sessionId) scopeMismatch();
}

function scopeInventorySnapshot(
  snapshot: Awaited<ReturnType<LocalServicesDaemonRuntime['inventoryRoutes']['getSnapshot']>>,
  workingDirectory: string,
) {
  return {
    ...snapshot,
    entries: snapshot.entries.filter((entry) => (
      localServiceInventoryEntryMatchesWorkspaceScope(entry, [workingDirectory])
    )),
  };
}

function scopePreviewSnapshot(snapshot: LocalServicePreviewSnapshotV1, sessionId: string): LocalServicePreviewSnapshotV1 {
  const resources = snapshot.resources.filter((resource) => (
    resource.sessionId === sessionId
    && resource.owner.kind === 'session'
    && resource.owner.id === sessionId
  ));
  const resourceIds = new Set(resources.map((resource) => resource.previewId));
  return {
    ...snapshot,
    resources,
    ...(snapshot.previews
      ? { previews: snapshot.previews.filter((preview) => resourceIds.has(preview.previewId)) }
      : {}),
  };
}

/**
 * Exact-Session adapter over the incumbent local-service runtime. The Runtime remains the only
 * scanner/registry/preview owner; this adapter only removes the Machine-wide views and mutation
 * leaves that the restricted Runner must not expose.
 */
export function createRestrictedRunnerLocalServicesRoutes(input: Readonly<{
  machineId: string;
  sessionId: string;
  workingDirectory: string;
  runtime: LocalServicesDaemonRuntime;
  publicPreviewRoutes: LocalServicePublicPreviewRoutes;
}>): DaemonLocalServicesMachineRpcRoutes {
  const inventoryRoutes: NonNullable<DaemonLocalServicesMachineRpcRoutes['localServicesInventory']> = {
    getSnapshot: async () => scopeInventorySnapshot(
      await input.runtime.inventoryRoutes.getSnapshot(),
      input.workingDirectory,
    ),
    refreshSnapshot: async () => scopeInventorySnapshot(
      await input.runtime.inventoryRoutes.refreshSnapshot(),
      input.workingDirectory,
    ),
    watchSnapshot: async (request) => {
      const result = await input.runtime.inventoryRoutes.watchSnapshot(request);
      return result.changed
        ? { changed: true, snapshot: scopeInventorySnapshot(result.snapshot, input.workingDirectory) }
        : result;
    },
  };

  const previewRoutes: NonNullable<DaemonLocalServicesMachineRpcRoutes['localServicesPreview']> = {
    resolveApplication: async binding => {
      if (binding.machineId !== input.machineId || binding.sessionId !== input.sessionId
        || binding.owner.kind !== 'session' || binding.owner.id !== input.sessionId) scopeMismatch();
      return await input.runtime.previewRoutes.resolveApplication(binding);
    },
    acquireNativeApplication: async () => {
      throw new PluginError({
        code: PLUGIN_SERVICE_UNAVAILABLE_CODE,
        message: 'Native application acquisition is unavailable in the restricted Runner',
      });
    },
    getSnapshot: async () => scopePreviewSnapshot(
      await input.runtime.previewRoutes.getSnapshot(),
      input.sessionId,
    ),
    openOrCreate: async (request: DaemonLocalServicePreviewOpenOrCreateRequestV1) => {
      requireExactTarget(request, input);
      if (request.inventoryEntryId) {
        const inventory = scopeInventorySnapshot(
          await input.runtime.inventoryRoutes.getSnapshot(),
          input.workingDirectory,
        );
        if (!inventory.entries.some((entry) => entry.id === request.inventoryEntryId)) scopeMismatch();
      }
      const result = await input.runtime.previewRoutes.openOrCreate(request);
      if (!result.ok) return result;
      if (
        result.response.preview.resource.sessionId !== input.sessionId
        || result.response.preview.resource.machineId !== input.machineId
      ) scopeMismatch();
      return {
        ok: true,
        response: {
          ...result.response,
          snapshot: scopePreviewSnapshot(result.response.snapshot, input.sessionId),
        },
      };
    },
    revoke: async (request: DaemonLocalServicePreviewRevokeRequestV1) => {
      const current = scopePreviewSnapshot(await input.runtime.previewRoutes.getSnapshot(), input.sessionId);
      if (!current.resources.some((resource) => resource.previewId === request.previewId)) scopeMismatch();
      const result = await input.runtime.previewRoutes.revoke(request);
      return result.ok
        ? {
            ok: true,
            response: {
              ...result.response,
              snapshot: scopePreviewSnapshot(result.response.snapshot, input.sessionId),
            },
          }
        : result;
    },
  };

  const publicPreviewRoutes: LocalServicePublicPreviewRoutes = {
    getStatus: async (request: DaemonLocalServicePublicPreviewStatusRequestV1) => {
      requireExactTarget(request, input);
      return await input.publicPreviewRoutes.getStatus(request);
    },
    createExposure: async (request: DaemonLocalServicePublicPreviewCreateRequestV1) => {
      requireExactTarget(request, input);
      return await input.publicPreviewRoutes.createExposure(request);
    },
    revokeExposure: async (request: DaemonLocalServicePublicPreviewRevokeRequestV1) => {
      requireExactTarget(request, input);
      return await input.publicPreviewRoutes.revokeExposure(request);
    },
    copyUrl: async (request: DaemonLocalServicePublicPreviewCopyUrlRequestV1) => {
      requireExactTarget(request, input);
      return await input.publicPreviewRoutes.copyUrl(request);
    },
  };

  return Object.freeze({
    localServicesInventory: inventoryRoutes,
    localServicesLauncher: {
      getSnapshot: async () => await input.runtime.launcherRoutes.getSnapshot({
        sessionId: input.sessionId,
        scope: 'workspace',
        workspaceRoot: input.workingDirectory,
      }),
    },
    localServicesPreview: previewRoutes,
    localServicesPublicPreview: publicPreviewRoutes,
  });
}
