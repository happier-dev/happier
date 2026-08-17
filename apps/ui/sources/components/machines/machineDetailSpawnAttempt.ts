import {
    SessionCreationKeyV1Schema,
    type SessionCreationKeyV1,
} from '@happier-dev/protocol';

export type MachineDetailSpawnAttempt = Readonly<{
    signature: string;
    userAttemptId: SessionCreationKeyV1;
}>;

export function resolveMachineDetailSpawnAttempt(params: Readonly<{
    current: MachineDetailSpawnAttempt | null;
    signature: string;
    createUserAttemptId: () => string;
}>): MachineDetailSpawnAttempt {
    if (params.current?.signature === params.signature) return params.current;
    return {
        signature: params.signature,
        userAttemptId: SessionCreationKeyV1Schema.parse(params.createUserAttemptId()),
    };
}
