/** The same finite-operation budget for tasks arriving progressively from a transport. */
export function createTaskLimiter(limit: number) {
    const maxConcurrency = Math.max(1, Math.trunc(limit));
    let running = 0;
    const waiting: Array<() => void> = [];
    const run = <T>(task: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
        const start = () => {
            running++;
            void Promise.resolve().then(task).then(resolve, reject).finally(() => {
                running--;
                waiting.shift()?.();
            });
        };
        if (running < maxConcurrency) start();
        else waiting.push(start);
    });
    return Object.assign(run, { hasWaitingTasks: () => waiting.length > 0 });
}

export async function runTasksWithLimit<T>(
    tasks: Array<() => Promise<T>>,
    limit: number
): Promise<T[]> {
    const maxConcurrency = Math.max(1, Math.trunc(limit));
    const results: T[] = new Array(tasks.length);

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= tasks.length) {
                return;
            }
            results[index] = await tasks[index]();
        }
    };

    const workersCount = Math.min(maxConcurrency, tasks.length);
    await Promise.all(Array.from({ length: workersCount }, () => worker()));
    return results;
}
