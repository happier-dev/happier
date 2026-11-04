import type { LiveWorkInventoryV1, ManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';

type BoundaryResult = Readonly<{ kind: 'settled' | 'incomplete' }>;

/** Awaits canonical material facts for one already admitted retirement operation.
 * The inventory re-observes only its emitting owner; this consumer never rereads
 * Session runtimes on a wake, polls, kills work or retains a pending-subject set.
 */
export async function waitForRequesterMachineNaturalBoundary(input: Readonly<{
  requester: RequesterWorkAttributionV1;
  inventory: Pick<ManagedActivityInventory, 'read' | 'subscribeFacts'>;
  signal: AbortSignal;
  isCurrentInstallation(): boolean;
  /** The awaiting retirement operation is custody, not member payload work. */
  excludeOperationId?: string;
}>): Promise<BoundaryResult> {
  if (input.signal.aborted || !input.isCurrentInstallation()) return { kind: 'incomplete' };
  return new Promise(resolve => {
    let finished = false;
    let unsubscribe = () => {};
    const finish = (kind: BoundaryResult['kind']) => {
      if (finished) return;
      finished = true;
      unsubscribe(); input.signal.removeEventListener('abort', aborted);
      resolve({ kind });
    };
    const aborted = () => finish('incomplete');
    const inspect = (facts: LiveWorkInventoryV1) => {
      if (finished) return;
      if (input.signal.aborted || !input.isCurrentInstallation() || facts.coverage !== 'complete') { finish('incomplete'); return; }
      let active = false;
      for (const item of facts.items) {
        // Session rows remain hosted lease owners even when their turn is idle.
        // Their canonical exit removes the row after native/material cleanup.
        if (item.state === 'settled' && item.category !== 'session'
          || input.excludeOperationId !== undefined && item.actionOperationId === input.excludeOperationId
          || item.category === 'service' && item.serviceIdentity?.kind === 'deployment') continue;
        const attribution = item.attribution;
        if ('kind' in attribution) { finish('incomplete'); return; }
        if (attribution.serverId !== input.requester.serverId || attribution.machineId !== input.requester.machineId
          || attribution.installationId !== input.requester.installationId || attribution.accountId !== input.requester.accountId) continue;
        if (item.state === 'unknown') { finish('incomplete'); return; }
        active = true;
      }
      if (!active) finish('settled');
    };
    // Subscribe before the initial confirmation so a same-turn exit is retained.
    unsubscribe = input.inventory.subscribeFacts(inspect);
    if (finished) { unsubscribe(); return; }
    input.signal.addEventListener('abort', aborted, { once: true });
    if (input.signal.aborted) { aborted(); return; }
    void input.inventory.read().then(inspect, () => finish('incomplete'));
  });
}
