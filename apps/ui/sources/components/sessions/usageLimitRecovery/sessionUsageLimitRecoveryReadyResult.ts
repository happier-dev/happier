export type ReadyUsageLimitRecoveryResult = 'resolved' | 'resume_failed';

export async function handleReadyUsageLimitRecoveryResult(params: Readonly<{
    sessionActive: boolean;
    resumeInactiveSession: () => Promise<boolean>;
    markResolved: () => void;
    markReady: () => void;
}>): Promise<ReadyUsageLimitRecoveryResult> {
    if (params.sessionActive) {
        params.markResolved();
        return 'resolved';
    }

    const resumed = await params.resumeInactiveSession();
    if (resumed) {
        params.markResolved();
        return 'resolved';
    }

    params.markReady();
    return 'resume_failed';
}
