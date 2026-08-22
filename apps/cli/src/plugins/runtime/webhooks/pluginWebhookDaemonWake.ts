import type { ApiMachineClient } from '@/api/apiMachine';

import type { PluginWebhookDaemonWorkerHandleV1 } from './pluginWebhookDaemonWorker';

/**
 * AccountChange is durable/currentness-bearing; this listener only converts
 * its optional socket hint into a trigger for the daemon's existing
 * single-flight polling owner. It never receives webhook delivery content.
 */
export function attachPluginWebhookDaemonWakeV1(params: Readonly<{
  apiMachine: Pick<ApiMachineClient, 'onUpdate'>;
  getWorker: () => Pick<PluginWebhookDaemonWorkerHandleV1, 'trigger'> | null;
}>): () => void {
  return params.apiMachine.onUpdate((update) => {
    if (update.body.t !== 'account-change') return;
    params.getWorker()?.trigger();
    return true;
  });
}
