export async function execute(): Promise<string> {
    const executor = await import('./pendingExecutor');
    return executor.execute();
}
