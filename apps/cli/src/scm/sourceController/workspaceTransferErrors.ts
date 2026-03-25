export function buildNonPortableWorkspacePathError(relativePath: string): Error {
    return new Error(`Workspace transfer contains non-portable workspace path: ${relativePath}`);
}
