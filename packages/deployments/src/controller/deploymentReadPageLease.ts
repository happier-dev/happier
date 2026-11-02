import { isDeploymentReadDemandActiveV1 } from './deploymentObservationDemand.js';
import type { DeploymentReadDemandV1, DeploymentReadLeaseV1, DeploymentReadPageFactsV1,
    DeploymentReadPageLeaseV1 } from './deploymentReadControllerTypes.js';

/** Navigation retains request positions, not page content; records remain owned by the controller. */
export function createDeploymentReadPageLease<T extends DeploymentReadPageFactsV1>(input: Readonly<{
    acquire(cursor: string | undefined, demand: DeploymentReadDemandV1): DeploymentReadLeaseV1<T>;
    nextCursor(cursor: string | undefined): string | null;
    initialCursor: string | undefined;
    demand: DeploymentReadDemandV1;
}>): DeploymentReadPageLeaseV1<T> {
    const cursors: (string | undefined)[] = input.initialCursor === undefined ? [undefined] : [undefined, input.initialCursor];
    let demand = input.demand;
    let held = input.acquire(cursors.at(-1), demand);
    let released = false;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    let unsubscribe = held.subscribe(notify);
    function move() {
        unsubscribe();
        held.release();
        held = input.acquire(cursors.at(-1), demand);
        unsubscribe = held.subscribe(notify);
        notify();
    }
    return {
        getSnapshot: () => held.getSnapshot(),
        subscribe(listener) {
            if (released) return () => {};
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        refresh: options => held.refresh(options),
        setDemand(next) { demand = next; held.setDemand(next); },
        nextPage() {
            if (released || !isDeploymentReadDemandActiveV1(demand) || held.getSnapshot().status !== 'ready') return;
            const cursor = input.nextCursor(cursors.at(-1));
            if (cursor === null) return;
            cursors.push(cursor);
            move();
        },
        previousPage() {
            if (released || !isDeploymentReadDemandActiveV1(demand) || cursors.length === 1) return;
            cursors.pop();
            move();
        },
        release() {
            if (released) return;
            released = true;
            unsubscribe();
            listeners.clear();
            held.release();
        },
    };
}
