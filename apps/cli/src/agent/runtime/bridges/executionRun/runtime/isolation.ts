type CleanupCarrier = Readonly<{
    cleanup?: (() => void | Promise<void>) | undefined;
}>;

export async function cleanupExecutionRunIsolationBundle(bundle: CleanupCarrier | null | undefined): Promise<void> {
    const cleanup = bundle?.cleanup;
    if (!cleanup) {
        return;
    }
    try {
        await Promise.resolve(cleanup());
    } catch {
        // Best-effort: isolation cleanup must not mask the primary runtime error.
    }
}
