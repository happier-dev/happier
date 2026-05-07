export type SyncGenerationGuard = Readonly<{
    shouldContinue: () => boolean;
}>;
export function createSyncGenerationGuard(params: {
    getCurrentGeneration: () => number;
    capturedGeneration: number;
}): SyncGenerationGuard {
    return {
        shouldContinue: () => params.getCurrentGeneration() === params.capturedGeneration,
    };
}
