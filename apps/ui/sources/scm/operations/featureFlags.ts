export function resolveScmWriteEnabled(input: {
    experiments: boolean;
    expScmOperations: boolean;
}): boolean {
    return input.experiments && input.expScmOperations;
}
