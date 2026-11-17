export type ScmWorkspaceIntegrationWorkspaceTransferIncludeIgnoredMode = 'exclude' | 'include_selected';

export type ScmWorkspaceIntegrationWorkspaceTransferConflictPolicy = 'create_sibling_copy' | 'replace_existing';

export type ScmWorkspaceIntegrationWorkspaceTransferStrategy = 'transfer_snapshot';

export const DEFAULT_SCM_WORKSPACE_INTEGRATION_WORKSPACE_TRANSFER_STRATEGY: ScmWorkspaceIntegrationWorkspaceTransferStrategy = 'transfer_snapshot';

export type ScmWorkspaceIntegrationWorkspaceTransferRequest = Readonly<{
    strategy: ScmWorkspaceIntegrationWorkspaceTransferStrategy;
    includeIgnoredMode: ScmWorkspaceIntegrationWorkspaceTransferIncludeIgnoredMode;
    ignoredIncludeGlobs: readonly string[];
    includeAllIgnored?: boolean;
    extraIgnorePatterns?: readonly string[];
    exclusionCandidates?: readonly string[];
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferRequestInput = Readonly<{
    strategy?: ScmWorkspaceIntegrationWorkspaceTransferStrategy;
    includeIgnoredMode: ScmWorkspaceIntegrationWorkspaceTransferIncludeIgnoredMode;
    ignoredIncludeGlobs: readonly string[];
    includeAllIgnored?: boolean;
    extraIgnorePatterns?: readonly string[];
    exclusionCandidates?: readonly string[];
    /** Export orchestration operand; SCM backends still receive their normal file-selection request. */
    contentOnly?: true;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferEntry = Readonly<{
    relativePath: string;
    sourcePath: string;
    disposeSource?: () => Promise<void> | void;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferMetadata = Readonly<Record<string, unknown>>;

export type ScmWorkspaceIntegrationWorkspaceTransferResult = Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    excludedPaths?: readonly string[];
    metadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
}>;

export function createScmWorkspaceIntegrationWorkspaceTransferRequest(
    input: ScmWorkspaceIntegrationWorkspaceTransferRequestInput,
): ScmWorkspaceIntegrationWorkspaceTransferRequest {
    return {
        strategy: input.strategy ?? DEFAULT_SCM_WORKSPACE_INTEGRATION_WORKSPACE_TRANSFER_STRATEGY,
        includeIgnoredMode: input.includeIgnoredMode,
        ignoredIncludeGlobs: [...input.ignoredIncludeGlobs],
        ...(input.includeAllIgnored === true ? { includeAllIgnored: true } : {}),
        ...(input.extraIgnorePatterns ? { extraIgnorePatterns: [...input.extraIgnorePatterns] } : {}),
        ...(input.exclusionCandidates ? { exclusionCandidates: [...input.exclusionCandidates] } : {}),
    };
}

export function createScmWorkspaceIntegrationWorkspaceTransferEntry(
    input: ScmWorkspaceIntegrationWorkspaceTransferEntry,
): ScmWorkspaceIntegrationWorkspaceTransferEntry {
    return {
        relativePath: input.relativePath,
        sourcePath: input.sourcePath,
        ...(input.disposeSource ? { disposeSource: input.disposeSource } : {}),
    };
}

export function createScmWorkspaceIntegrationWorkspaceTransferResult(input: Readonly<{
    entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
    excludedPaths?: readonly string[];
    metadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata | null;
}>): ScmWorkspaceIntegrationWorkspaceTransferResult {
    return {
        entries: input.entries.map((entry) => createScmWorkspaceIntegrationWorkspaceTransferEntry(entry)),
        ...(input.excludedPaths ? { excludedPaths: [...input.excludedPaths] } : {}),
        metadata: input.metadata ?? null,
    };
}
