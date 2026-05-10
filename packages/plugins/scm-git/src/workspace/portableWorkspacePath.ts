export type ScmWorkspaceIntegrationPortableWorkspacePathClassification =
  | 'portable'
  | 'non_portable'
  | 'scm_administrative'
  | 'unknown';

export type ScmWorkspaceIntegrationPortableWorkspacePathRequest = Readonly<{
  relativePath: string;
}>;

export function resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath(
  input: ScmWorkspaceIntegrationPortableWorkspacePathRequest,
): string {
  return input.relativePath;
}
