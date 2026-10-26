export type ReadyUsageLimitRecoveryResult = 'ready' | 'resume_failed';

export async function handleReadyUsageLimitRecoveryResult(params: Readonly<{
    sessionActive: boolean;
    resumeInactiveSession: () => Promise<boolean>;
    markReady: () => void;
}>): Promise<ReadyUsageLimitRecoveryResult> {
    if (params.sessionActive) {
        params.markReady();
        return 'ready';
    }

    const resumed = await params.resumeInactiveSession();
    if (resumed) {
        params.markReady();
        return 'ready';
    }

    params.markReady();
    return 'resume_failed';
}
