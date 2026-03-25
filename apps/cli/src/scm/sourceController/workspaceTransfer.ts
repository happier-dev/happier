export type ScmSourceControllerWorkspaceTransferIncludeIgnoredMode = 'exclude' | 'include_selected';

export type ScmSourceControllerWorkspaceTransferConflictPolicy = 'create_sibling_copy' | 'replace_existing';

export type ScmSourceControllerWorkspaceTransferStrategy = 'transfer_snapshot' | 'sync_changes';

export const DEFAULT_SCM_SOURCE_CONTROLLER_WORKSPACE_TRANSFER_STRATEGY: ScmSourceControllerWorkspaceTransferStrategy = 'transfer_snapshot';

export type ScmSourceControllerWorkspaceTransferRequest = Readonly<{
    strategy: ScmSourceControllerWorkspaceTransferStrategy;
    includeIgnoredMode: ScmSourceControllerWorkspaceTransferIncludeIgnoredMode;
    ignoredIncludeGlobs: readonly string[];
}>;

export type ScmSourceControllerWorkspaceTransferRequestInput = Readonly<{
    strategy?: ScmSourceControllerWorkspaceTransferStrategy;
    includeIgnoredMode: ScmSourceControllerWorkspaceTransferIncludeIgnoredMode;
    ignoredIncludeGlobs: readonly string[];
}>;

export type ScmSourceControllerWorkspaceTransferEntry = Readonly<{
    relativePath: string;
    sourcePath: string;
}>;

export type ScmSourceControllerWorkspaceTransferMetadata = Readonly<Record<string, unknown>>;

export type ScmSourceControllerWorkspaceTransferResult = Readonly<{
    entries: readonly ScmSourceControllerWorkspaceTransferEntry[];
    metadata?: ScmSourceControllerWorkspaceTransferMetadata | null;
}>;

export function createScmSourceControllerWorkspaceTransferRequest(
    input: ScmSourceControllerWorkspaceTransferRequestInput,
): ScmSourceControllerWorkspaceTransferRequest {
    return {
        strategy: input.strategy ?? DEFAULT_SCM_SOURCE_CONTROLLER_WORKSPACE_TRANSFER_STRATEGY,
        includeIgnoredMode: input.includeIgnoredMode,
        ignoredIncludeGlobs: [...input.ignoredIncludeGlobs],
    };
}

export function createScmSourceControllerWorkspaceTransferEntry(
    input: ScmSourceControllerWorkspaceTransferEntry,
): ScmSourceControllerWorkspaceTransferEntry {
    return {
        relativePath: input.relativePath,
        sourcePath: input.sourcePath,
    };
}

export function createScmSourceControllerWorkspaceTransferResult(input: Readonly<{
    entries: readonly ScmSourceControllerWorkspaceTransferEntry[];
    metadata?: ScmSourceControllerWorkspaceTransferMetadata | null;
}>): ScmSourceControllerWorkspaceTransferResult {
    return {
        entries: input.entries.map((entry) => createScmSourceControllerWorkspaceTransferEntry(entry)),
        metadata: input.metadata ?? null,
    };
}
