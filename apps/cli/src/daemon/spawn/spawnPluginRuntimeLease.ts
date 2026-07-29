import { configuration } from '@/configuration';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

type PluginRuntimeLease = Awaited<
    ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
>;

/** Owns the one plugin runtime lease shared across connected-service, Provider, and Agent spawn preparation. */
export function createSpawnPluginRuntimeLease(
    launchResourceScope: ProviderLaunchResourceScope,
) {
    let lease: PluginRuntimeLease | null = null;
    let released = false;

    const release = async () => {
        if (!lease || released) return;
        released = true;
        const ownedLease = lease;
        lease = null;
        await ownedLease.release();
    };

    return {
        get currentRegistry(): PluginRuntimeLease['registry'] | null {
            return released ? null : lease?.registry ?? null;
        },
        async acquire(): Promise<PluginRuntimeLease> {
            if (lease && !released) return lease;
            released = false;
            lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                happyHomeDir: configuration.happyHomeDir,
            });
            launchResourceScope.register(release);
            return lease;
        },
        release,
    };
}

export type SpawnPluginRuntimeLease = ReturnType<typeof createSpawnPluginRuntimeLease>;
