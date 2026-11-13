let markExecutorLoading!: () => void;
let releaseExecutor!: () => void;

export const executorLoading = new Promise<void>((resolve) => { markExecutorLoading = resolve; });
export const executorRelease = new Promise<void>((resolve) => { releaseExecutor = resolve; });
export { markExecutorLoading, releaseExecutor };
