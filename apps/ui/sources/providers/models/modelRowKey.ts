export function providerModelRowKey(connectionId: string, modelId: string): string {
    return JSON.stringify(['provider-model', connectionId, modelId]);
}
