import type {
    QueuedSessionClientDurableMutation,
    SessionClientDurableMutationDependency,
} from './sessionClientDurableMutationTypes';

export function readSessionClientDurableMutationDependencies(
    mutation: QueuedSessionClientDurableMutation,
): readonly SessionClientDurableMutationDependency[] {
    if (mutation.dependsOn) return mutation.dependsOn;
    return mutation.kind === 'registered_session_state_field'
        ? mutation.payload.dependsOn ?? []
        : [];
}

/**
 * Returns only mutations that participate in a dependency cycle. Dependents of
 * a cycle remain outside the result so the ordinary failed-prerequisite path
 * can retain the exact prerequisite that made them terminal.
 */
export function findSessionClientDurableMutationDependencyCycles(
    mutations: readonly QueuedSessionClientDurableMutation[],
): ReadonlyMap<string, readonly string[]> {
    const mutationIds: string[] = [];
    const knownMutationIds = new Set<string>();
    for (const mutation of mutations) {
        if (knownMutationIds.has(mutation.mutationId)) continue;
        knownMutationIds.add(mutation.mutationId);
        mutationIds.push(mutation.mutationId);
    }

    const dependenciesByMutationId = new Map<string, string[]>();
    const dependentsByMutationId = new Map<string, string[]>();
    for (const mutationId of mutationIds) {
        dependenciesByMutationId.set(mutationId, []);
        dependentsByMutationId.set(mutationId, []);
    }
    for (const mutation of mutations) {
        const dependencies = dependenciesByMutationId.get(mutation.mutationId);
        if (!dependencies) continue;
        const seenDependencies = new Set(dependencies);
        for (const dependency of readSessionClientDurableMutationDependencies(mutation)) {
            if (!knownMutationIds.has(dependency.mutationId) || seenDependencies.has(dependency.mutationId)) {
                continue;
            }
            seenDependencies.add(dependency.mutationId);
            dependencies.push(dependency.mutationId);
            dependentsByMutationId.get(dependency.mutationId)?.push(mutation.mutationId);
        }
    }

    // Iterative Kosaraju traversal avoids call-stack exhaustion on a large or
    // corrupt persisted journal while still identifying exact cycle members.
    const visited = new Set<string>();
    const finishOrder: string[] = [];
    for (const rootMutationId of mutationIds) {
        if (visited.has(rootMutationId)) continue;
        visited.add(rootMutationId);
        const stack: Array<{ mutationId: string; nextDependencyIndex: number }> = [{
            mutationId: rootMutationId,
            nextDependencyIndex: 0,
        }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (!frame) break;
            const dependencies = dependenciesByMutationId.get(frame.mutationId) ?? [];
            const dependencyMutationId = dependencies[frame.nextDependencyIndex];
            if (dependencyMutationId !== undefined) {
                frame.nextDependencyIndex += 1;
                if (!visited.has(dependencyMutationId)) {
                    visited.add(dependencyMutationId);
                    stack.push({ mutationId: dependencyMutationId, nextDependencyIndex: 0 });
                }
                continue;
            }
            finishOrder.push(frame.mutationId);
            stack.pop();
        }
    }

    const assigned = new Set<string>();
    const cyclesByMutationId = new Map<string, readonly string[]>();
    for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
        const rootMutationId = finishOrder[index];
        if (!rootMutationId || assigned.has(rootMutationId)) continue;
        assigned.add(rootMutationId);
        const component: string[] = [];
        const stack = [rootMutationId];
        while (stack.length > 0) {
            const mutationId = stack.pop();
            if (!mutationId) continue;
            component.push(mutationId);
            for (const dependentMutationId of dependentsByMutationId.get(mutationId) ?? []) {
                if (assigned.has(dependentMutationId)) continue;
                assigned.add(dependentMutationId);
                stack.push(dependentMutationId);
            }
        }
        const isCycle = component.length > 1
            || (dependenciesByMutationId.get(rootMutationId) ?? []).includes(rootMutationId);
        if (!isCycle) continue;
        const cycleMutationIds = [...component].sort();
        for (const mutationId of component) {
            cyclesByMutationId.set(mutationId, cycleMutationIds);
        }
    }
    return cyclesByMutationId;
}
