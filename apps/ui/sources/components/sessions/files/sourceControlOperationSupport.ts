export type SourceControlOperationCapabilities = {
    readLog?: boolean;
    writeCommit?: boolean;
    writeRemoteFetch?: boolean;
    writeRemotePull?: boolean;
    writeRemotePush?: boolean;
} | null | undefined;

export type SourceControlOperationSupport = {
    supportsHistory: boolean;
    supportsCommit: boolean;
    supportsFetch: boolean;
    supportsPull: boolean;
    supportsPush: boolean;
};

export function resolveSourceControlOperationSupport(
    capabilities: SourceControlOperationCapabilities,
): SourceControlOperationSupport {
    return {
        supportsHistory: capabilities?.readLog ?? false,
        supportsCommit: capabilities?.writeCommit ?? false,
        supportsFetch: capabilities?.writeRemoteFetch ?? false,
        supportsPull: capabilities?.writeRemotePull ?? false,
        supportsPush: capabilities?.writeRemotePush ?? false,
    };
}
