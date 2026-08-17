export async function callGuardedMachineRpcWithPolicy(): Promise<never> {
    throw new Error('unexpected machine RPC in artifact-cache unit test');
}
