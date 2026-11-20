import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';

import type { PluginUiResourceError, PluginUiResourceSnapshot } from './resourceStore.js';

/** Withdraw terminal authority; a recoverable replacement owns read settlement. */
export function settleResourceWatchTermination(input: Readonly<{
  event: Exclude<ResourceSubscriptionEvent, { kind: 'invalidated' | 'pages' }>;
  snapshot: PluginUiResourceSnapshot;
  established: boolean;
  canReplace: boolean;
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
  if (event.code === 'expired_resource' && input.canReplace
    && (input.established || event.diagnostics.includes('plugin_read_authority_retired'))) {
    // A producer can withdraw read authority before the host acknowledges the
    // watch. Readmission uses the same path as withdrawal of a live watch.
    input.replace(error);
    return;
  }
  input.fail(error);
}
