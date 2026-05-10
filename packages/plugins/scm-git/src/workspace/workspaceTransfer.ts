export type ScmWorkspaceIntegrationWorkspaceTransferIncludeIgnoredMode = 'exclude' | 'include_selected';
export type ScmWorkspaceIntegrationWorkspaceTransferConflictPolicy = 'create_sibling_copy' | 'replace_existing';
export type ScmWorkspaceIntegrationWorkspaceTransferStrategy = 'transfer_snapshot' | 'sync_changes';

export const DEFAULT_SCM_WORKSPACE_INTEGRATION_WORKSPACE_TRANSFER_STRATEGY: ScmWorkspaceIntegrationWorkspaceTransferStrategy = 'transfer_snapshot';

export type ScmWorkspaceIntegrationWorkspaceTransferRequest = Readonly<{
  strategy: ScmWorkspaceIntegrationWorkspaceTransferStrategy;
  includeIgnoredMode: ScmWorkspaceIntegrationWorkspaceTransferIncludeIgnoredMode;
  ignoredIncludeGlobs: readonly string[];
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferEntry = Readonly<{
  relativePath: string;
  sourcePath: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferMetadata = Readonly<Record<string, unknown>>;

export type ScmWorkspaceIntegrationWorkspaceTransferResult = Readonly<{
  entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
  metadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
}>;

export function createScmWorkspaceIntegrationWorkspaceTransferEntry(
  input: ScmWorkspaceIntegrationWorkspaceTransferEntry,
): ScmWorkspaceIntegrationWorkspaceTransferEntry {
  return {
    relativePath: input.relativePath,
    sourcePath: input.sourcePath,
  };
}
