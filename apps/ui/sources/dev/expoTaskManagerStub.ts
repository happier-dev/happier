const definedTasks = new Map<string, unknown>();
const registeredTasks = new Set<string>();

export function defineTask(taskName: string, taskExecutor: unknown): void {
    definedTasks.set(taskName, taskExecutor);
}

export function isTaskDefined(taskName: string): boolean {
    return definedTasks.has(taskName);
}

export async function isTaskRegisteredAsync(taskName: string): Promise<boolean> {
    return registeredTasks.has(taskName);
}

export async function unregisterTaskAsync(taskName: string): Promise<void> {
    registeredTasks.delete(taskName);
}

export async function isAvailableAsync(): Promise<boolean> {
    return true;
}
