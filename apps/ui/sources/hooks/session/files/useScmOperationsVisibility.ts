export function shouldShowScmOperationsPanel(input: {
    isRefreshing: boolean;
    isRepo: boolean;
    capabilities?: {
        readStatus?: boolean;
    } | null;
    scmWriteEnabled: boolean;
}): boolean {
    const canReadStatus = input.capabilities?.readStatus ?? false;
    return !input.isRefreshing && input.isRepo && canReadStatus;
}
