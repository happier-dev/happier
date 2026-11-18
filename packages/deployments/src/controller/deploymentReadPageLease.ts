import { isDeploymentReadDemandActiveV1 } from './deploymentObservationDemand.js';
import type { DeploymentReadDemandV1, DeploymentReadLeaseV1, DeploymentReadPageFactsV1,
    DeploymentReadPageLeaseV1 } from './deploymentReadControllerTypes.js';

/** Navigation retains request positions, not page content; records remain owned by the controller. */
export function createDeploymentReadPageLease<T extends DeploymentReadPageFactsV1, PageOption extends string = never>(input: Readonly<{
    acquire(cursor: string | undefined, demand: DeploymentReadDemandV1, option?: PageOption): DeploymentReadLeaseV1<T>;
    nextCursor(cursor: string | undefined, option?: PageOption): string | null;
    initialCursor: string | undefined;
    demand: DeploymentReadDemandV1;
}>): DeploymentReadPageLeaseV1<T, PageOption> {
    const positions: { cursor: string | undefined; option?: PageOption | undefined }[] = [{ cursor: undefined }];
    if (input.initialCursor !== undefined) positions.push({ cursor: input.initialCursor });
    let demand = input.demand;
    let held = acquireCurrentPage();
    let released = false;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    let unsubscribe = held.subscribe(notify);
    function acquireCurrentPage() {
        const { cursor, option } = positions.at(-1)!;
        return input.acquire(cursor, demand, option);
    }
    function move() {
        unsubscribe();
        held.release();
        held = acquireCurrentPage();
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
        nextPage(option) {
            if (released || !isDeploymentReadDemandActiveV1(demand) || held.getSnapshot().status !== 'ready') return;
            const current = positions.at(-1)!;
            const cursor = input.nextCursor(current.cursor, current.option);
            if (cursor === null) return;
            positions.push({ cursor, option });
            move();
        },
        previousPage() {
            if (released || !isDeploymentReadDemandActiveV1(demand) || positions.length === 1) return;
            positions.pop();
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
