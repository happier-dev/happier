import type {
  ChannelBindingStore,
  ChannelBridgeAdapter,
  ChannelBridgeDeps,
  ChannelBridgeWorkerHandle,
} from '@/channels/core/channelBridgeWorker';
import { startChannelBridgeWorker } from '@/channels/core/channelBridgeWorker';
import type { ChannelBridgeRuntimeConfig } from '@/channels/channelBridgeConfig';
import { listChannelBridgeProviderIds, resolveChannelBridgeProviderDefinition } from '@/channels/providers/_registry/channelBridgeProviderRegistry';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

export type ChannelBridgeRuntimeHandle = ChannelBridgeWorkerHandle;

async function startProviderRuntimes(params: Readonly<{
  runtimeConfig: ChannelBridgeRuntimeConfig;
}>): Promise<Readonly<{ adapters: readonly ChannelBridgeAdapter[]; stop: () => Promise<void> }>> {
  const adapters: ChannelBridgeAdapter[] = [];
  const stopFns: Array<() => Promise<void>> = [];

  for (const providerId of listChannelBridgeProviderIds()) {
    const provider = resolveChannelBridgeProviderDefinition(providerId);
    const providerConfig = provider.readConfig(params.runtimeConfig);
    let runtime: Awaited<ReturnType<typeof provider.createRuntime>> | null;
    try {
      runtime = await provider.createRuntime({ config: providerConfig });
    } catch (error) {
      logger.warn(
        `[channelBridge] Failed to start provider runtime (provider=${providerId}); skipping provider`,
        serializeAxiosErrorForLog(error),
      );
      continue;
    }
    if (!runtime) continue;
    adapters.push(...runtime.adapters);
    stopFns.push(runtime.stop);
  }

  return {
    adapters,
    stop: async () => {
      for (const stop of stopFns) {
        try {
          await stop();
        } catch {
          // Best-effort shutdown: keep stopping remaining provider runtimes.
        }
      }
    },
  };
}

export async function startChannelBridgeRuntime(params: Readonly<{
  store: ChannelBindingStore;
  deps: ChannelBridgeDeps;
  runtimeConfig: ChannelBridgeRuntimeConfig;
}>): Promise<ChannelBridgeRuntimeHandle | null> {
  const providers = await startProviderRuntimes({ runtimeConfig: params.runtimeConfig });
  if (providers.adapters.length === 0) return null;

  let worker: ChannelBridgeWorkerHandle;
  try {
    worker = startChannelBridgeWorker({
      store: params.store,
      adapters: providers.adapters,
      deps: params.deps,
      tickMs: params.runtimeConfig.tickMs,
    });
  } catch (error) {
    await providers.stop().catch(() => undefined);
    throw error;
  }

  let stopped = false;
  return {
    trigger: worker.trigger,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await worker.stop();
      } finally {
        await providers.stop();
      }
    },
  };
}
