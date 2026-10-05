export function startMachineCarrierGrantIntegrationFixture(input: Readonly<{
    accountId: string;
    machineId: string;
    targetEndpointId: string;
    invalidateGrant: boolean;
}>): Promise<Readonly<{
    serverUrl: string;
    signingKeyId: string;
    signingPublicKeyBase64Url: string;
    grantRequests: readonly unknown[];
    grantAuthorizationHeaders: readonly (string | undefined)[];
    close(): Promise<void>;
}>>;

export function startNativePreviewHomeIntegrationFixture(input: Readonly<{
    accountId: string;
}>): Promise<Readonly<{
    serverUrl: string;
    token: string;
    trustRoots: readonly Readonly<{ keyId: string; publicKey: string }>[];
    close(): Promise<void>;
}>>;
