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
  recover(error: PluginUiResourceError, reopenWatch: boolean): void;
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
  if (event.code === 'expired_resource') {
    const readAuthorityRetired = event.diagnostics.includes('plugin_read_authority_retired');
    const reopenWatch = input.canReplace && (input.established || readAuthorityRetired);
    if (reopenWatch || readAuthorityRetired) {
      // Losing observation authority again during readmission still leaves
      // the open or Refresh entitled to a new, independent snapshot admission.
      input.recover(error, reopenWatch);
      return;
    }
  }
  input.fail(error);
}
