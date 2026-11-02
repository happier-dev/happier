import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { MachineRecipeReadTargetV1Schema, type MachineRecipeReadTargetV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';

/** Project only the optional target fact from the same opened Machine owner. */
export function projectMachineRecipeReadTarget(
  snapshot: ReturnType<ApiMachineClient['getMachineMetadataSnapshot']> | undefined,
): MachineRecipeReadTargetV1 | undefined {
  if (snapshot?.status !== 'ready') return undefined;
  const target = MachineRecipeReadTargetV1Schema.safeParse({
    platform: snapshot.metadata.platform,
    ...(snapshot.metadata.arch !== undefined ? { arch: snapshot.metadata.arch } : {}),
  });
  return target.success ? target.data : undefined;
}

/** The admitted receiving daemon reads its own cold family, without a self-RPC. */
export function createMachineRecipeReadAction(params: Readonly<{
  homeId: string;
  machineId: string;
  readMachineMetadataSnapshot?: () => ReturnType<ApiMachineClient['getMachineMetadataSnapshot']>;
  acquirePluginRuntimeRegistryLease: () => Promise<PluginRuntimeRegistryLease>;
  isCurrent: (context: RpcActionExecutorContext) => Promise<boolean>;
}>): NonNullable<ActionExecutorDeps['machineRecipesRead']> {
  return async (input, context) => {
    const unavailable = { ok: false as const, errorCode: 'unavailable', error: 'unavailable' };
    const matchesReceiver = () => input.homeId === params.homeId && input.machineId === params.machineId
      && (!context.externalActionTarget || context.externalActionTarget.kind === 'machine'
        && context.externalActionTarget.machineId === params.machineId);
    const isCurrent = async () => {
      context.signal?.throwIfAborted();
      if (!matchesReceiver()) return false;
      const current = await params.isCurrent(context);
      context.signal?.throwIfAborted();
      return current && matchesReceiver();
    };
    try {
      if (!await isCurrent()) return unavailable;
      let result: Awaited<ReturnType<NonNullable<ActionExecutorDeps['machineRecipesRead']>>> = unavailable;
      let lease: PluginRuntimeRegistryLease | undefined;
      try {
        lease = await params.acquirePluginRuntimeRegistryLease();
        if (await isCurrent() && lease.registry.contributes.machineRecipes !== undefined) {
          const runtimeRegistry = lease.registry;
          const family = buildPluginProjectionFamilyV2({ registry: runtimeRegistry.contributes,
            generation: runtimeRegistry.generation,
            readPluginBrandAsset: pluginId => runtimeRegistry.getPluginBrandAsset?.(pluginId),
            ...(input.recipeRefs !== undefined ? { machineRecipeRefs: input.recipeRefs } : {}),
          }, machineRecipesProjectionFamily);
          const target = projectMachineRecipeReadTarget(params.readMachineMetadataSnapshot?.());
          result = { entries: Object.values(family.entriesById), ...(target ? { target } : {}) };
        }
      } finally { await lease?.release(); }
      // Release may await retired-registry disposal. No descriptor crosses an
      // authority change that happened while that existing owner was settling.
      return await isCurrent() ? result : unavailable;
    } catch {
      context.signal?.throwIfAborted();
      return unavailable;
    }
  };
}
