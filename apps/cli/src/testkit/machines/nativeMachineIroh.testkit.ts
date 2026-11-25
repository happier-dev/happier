import { createIrohNodeNativeModule, loadIrohNodeNativeAddon } from '@happier-dev/iroh-native/node';
import { onTestFinished } from 'vitest';
import { createDaemonMachineIrohRuntime } from '@/daemon/peer/iroh/daemonMachineIrohRuntime';

/** Starts a real local carrier from the worker's built addon or an explicitly supplied test artifact. */
export async function startNativeMachineIrohFixture(happyHomeDir: string) {
  const artifact = process.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH?.trim();
  const native = artifact ? createIrohNodeNativeModule(loadIrohNodeNativeAddon(artifact)) : undefined;
  const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir, identity: 'ephemeral',
    relayConfig: { relayPolicy: 'disabled', relayUrls: [] }, ...(native ? { native } : {}) });
  onTestFinished(runtime.shutdown);
  if (!runtime.available) {
    if (runtime.reason === 'native_unavailable') {
      throw new Error(`${runtime.message}. Build @happier-dev/iroh-native or set HAPPIER_TEST_IROH_NODE_ADDON_PATH.`);
    }
    throw new Error('Native Machine Iroh fixture endpoint failed to start', { cause: runtime.error });
  }
  return runtime;
}
