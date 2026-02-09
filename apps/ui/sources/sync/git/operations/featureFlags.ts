export function resolveGitWriteEnabled(input: {
    experiments: boolean;
    expGitOperations: boolean;
}): boolean {
    return input.experiments && input.expGitOperations;
}
