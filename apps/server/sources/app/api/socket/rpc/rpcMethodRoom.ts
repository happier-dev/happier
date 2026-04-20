export function buildRpcMethodRoom(params: Readonly<{
    userId: string;
    method: string;
}>): string {
    if (!params.userId) {
        throw new Error("buildRpcMethodRoom: userId is required");
    }
    if (!params.method) {
        throw new Error("buildRpcMethodRoom: method is required");
    }
    return `rpc:${params.userId}:${params.method}`;
}
