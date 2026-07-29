export type MachineDetailSpawnAttempt = Readonly<{
    signature: string;
    userAttemptId: string;
    spawnNonce: string;
}>;

export function resolveMachineDetailSpawnAttempt(params: Readonly<{
    current: MachineDetailSpawnAttempt | null;
    signature: string;
    createUserAttemptId: () => string;
    createSpawnNonce: () => string;
}>): MachineDetailSpawnAttempt {
    if (params.current?.signature === params.signature) return params.current;
    return {
        signature: params.signature,
        userAttemptId: params.createUserAttemptId(),
        spawnNonce: params.createSpawnNonce(),
    };
}
