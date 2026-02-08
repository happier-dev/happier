export function shouldShowGitOperationsPanel(input: {
    isRefreshing: boolean;
    isGitRepo: boolean;
    gitWriteEnabled: boolean;
}): boolean {
    return !input.isRefreshing && input.isGitRepo && input.gitWriteEnabled;
}
