import type { SystemTaskRunState } from '@/components/systemTasks/types';

export function decorateLocalControlSnapshot(snapshot: SystemTaskRunState): SystemTaskRunState {
    return snapshot;
}
