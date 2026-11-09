/** Shared pixels belong to current consumers, not to their history of render configurations. */
export function createBackdropRenderCache<T>(render: (key: string, signal: AbortSignal) => Promise<T>, retire?: (value: T) => void) {
    type Job = { controller: AbortController; promise: Promise<T>; users: number; settled: boolean; value?: T };
    const jobs = new Map<string, Job>();
    const release = (key: string, job: Job) => {
        if (job.users !== 0) return;
        if (jobs.get(key) === job) jobs.delete(key);
        if (!job.settled) job.controller.abort();
        else if (job.value !== undefined) retire?.(job.value);
    };
    return {
        acquire(key: string) {
            let job = jobs.get(key);
            if (!job) {
                const controller = new AbortController();
                const created: Job = { controller, users: 0, settled: false, promise: render(key, controller.signal).then(value => {
                    created.value = value;
                    created.settled = true;
                    release(key, created);
                    return value;
                }, error => { if (jobs.get(key) === created) jobs.delete(key); throw error; }) };
                job = created;
                jobs.set(key, job);
            }
            job.users++;
            let held = true;
            return { promise: job.promise, release() {
                if (!held) return;
                held = false;
                job.users--;
                release(key, job);
            } };
        },
        clear() {
            for (const job of jobs.values()) if (!job.settled) job.controller.abort();
            jobs.clear();
        },
    };
}
