import type {
  PackedManagedProviderPreparedInput,
} from '../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import type {
  PackedManagedProviderActivationFailureObservation,
  PackedManagedProviderFreshSpawnObservation,
  PackedManagedProviderLiveSystem,
  PackedManagedProviderWrapperObservation,
} from './packedManagedProviderLiveScenario';

type ManagedComposedRuntime = Readonly<{
  probePublicProviderActivation(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderWrapperObservation>;
  probeFreshManagedSpawn(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderFreshSpawnObservation>;
  probeActivationFailureCleanup(
    input: PackedManagedProviderPreparedInput,
  ): Promise<PackedManagedProviderActivationFailureObservation>;
  cleanup(): Promise<void>;
}>;

async function loadManagedComposedRuntime(): Promise<ManagedComposedRuntime> {
  const module = await import('./packedManagedProviderComposedRuntime');
  return await module.startPackedManagedProviderComposedRuntime();
}

/**
 * One packed live owner for the installed/bundled public Provider path.
 * Every probe shares the exact candidate daemon and public runtime generation;
 * this entry point never starts or inspects the packaged wrapper directly.
 */
export function createCanonicalPackedManagedProviderLiveSystem():
PackedManagedProviderLiveSystem {
  let runtimePromise: Promise<ManagedComposedRuntime> | null = null;
  const runtime = (): Promise<ManagedComposedRuntime> => {
    runtimePromise ??= loadManagedComposedRuntime();
    return runtimePromise;
  };

  return {
    probePackagedWrapper: async (input) =>
      await (await runtime()).probePublicProviderActivation(input),
    probeFreshManagedSpawn: async (input) =>
      await (await runtime()).probeFreshManagedSpawn(input),
    probeActivationFailureCleanup: async (input) =>
      await (await runtime()).probeActivationFailureCleanup(input),
    cleanup: async () => {
      if (!runtimePromise) return;
      await (await runtimePromise).cleanup();
      runtimePromise = null;
    },
  };
}
