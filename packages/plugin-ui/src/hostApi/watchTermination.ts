import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';

import type { PluginUiResourceError, PluginUiResourceSnapshot } from './resourceStore.js';

/** Withdraw terminal authority; a recoverable replacement owns read settlement. */
export function settleResourceWatchTermination(input: Readonly<{
  event: Exclude<ResourceSubscriptionEvent, { kind: 'invalidated' }>;
  snapshot: PluginUiResourceSnapshot;
  established: boolean;
  demanded: boolean;
  stop(): void;
  publish(snapshot: PluginUiResourceSnapshot): void;
  fail(error: PluginUiResourceError): void;
  replace(error: PluginUiResourceError): void;
}>): void {
  const { event, snapshot } = input;
  input.stop();
  if (event.kind === 'complete') {
    // Completion preserves admitted bytes until the mount itself retires.
    input.publish({
      ...(snapshot.value === undefined ? {} : { value: snapshot.value, digest: snapshot.digest }),
      freshness: snapshot.freshness,
      pending: 'idle',
      subscription: 'ended',
    });
    return;
  }
  const error = Object.freeze({
    code: event.code,
    ...(event.diagnostics.length > 0 ? { diagnostics: Object.freeze([...event.diagnostics]) } : {}),
    message: event.diagnostics.join(', ') || 'Plugin UI resource watch ended.',
  });
  if (event.code === 'expired_resource' && input.established && input.demanded) {
    // Only a previously admitted watch can recover a replacement. Expiry
    // before acknowledgement ends that opening; its late handle is released
    // by the same aborted-controller path as disposal during establishment.
    input.replace(error);
    return;
  }
  input.fail(error);
}
