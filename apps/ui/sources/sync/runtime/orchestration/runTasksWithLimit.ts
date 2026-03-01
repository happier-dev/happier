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
