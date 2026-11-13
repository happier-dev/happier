import './pendingExecutorFrontDoor';
import { executorRelease, markExecutorLoading } from './pendingExecutorControl';

markExecutorLoading();
await executorRelease;
const leaf = await import('./pendingExecutorLeaf');

export function execute(): string {
    return leaf.readInitializedValue();
}
