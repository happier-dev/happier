import { dispatchBridgeLifecycleHookEvent } from '@/extensions/hooks/execution/dispatchBridgeLifecycleHookEvent';
import type { BridgeLifecycleHookDispatchEvent } from '@/extensions/hooks/execution/dispatchBridgeLifecycleHookEvent';

export async function emitBridgeLifecycleHookEventBestEffort(params: Readonly<{
  happyHomeDir: string;
  event: BridgeLifecycleHookDispatchEvent;
}>): Promise<void> {
  try {
    await dispatchBridgeLifecycleHookEvent({
      happyHomeDir: params.happyHomeDir,
      event: params.event,
    });
  } catch {
    // Best effort so extension hook failures cannot break host lifecycle operations.
  }
}
