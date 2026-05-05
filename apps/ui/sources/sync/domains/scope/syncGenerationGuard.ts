export type SyncGenerationGuard = Readonly<{
    capturedGeneration: number;
    shouldContinue: () => boolean;
}>;

export function createSyncGenerationGuard(params: Readonly<{
    getCurrentGeneration: () => number;
    capturedGeneration: number;
}>): SyncGenerationGuard {
    const capturedGeneration = params.capturedGeneration;
    return {
        capturedGeneration,
        shouldContinue: () => params.getCurrentGeneration() === capturedGeneration,
    };
}
