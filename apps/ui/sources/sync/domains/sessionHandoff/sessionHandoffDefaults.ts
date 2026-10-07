import { DEFAULT_SESSION_HANDOFF_DEFAULTS_V1, SessionHandoffDefaultsV1Schema, type SessionHandoffDefaultsV1, type SessionHandoffDirectTargetMode } from '@happier-dev/protocol/account/settings/accountSettings';
import { computeWorkspaceSyncPolicyDigest, type HandoffWorkspaceActionV1, type WorkspaceContentPolicyV1, type WorkspaceSyncModeV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export {
    DEFAULT_SESSION_HANDOFF_DEFAULTS_V1,
    SessionHandoffDefaultsV1Schema,
    type SessionHandoffDefaultsV1,
    type SessionHandoffDirectTargetMode,
};

export type SessionHandoffWorkspaceMode = 'none' | WorkspaceSyncModeV1;

/**
 * Workspace actions are intentionally one explicit choice. The old
 * transfer/sync strategy split is not represented in UI state anymore.
 */
export const SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS = [
    {
        id: 'keep_synced',
        titleKey: 'workspaceSync.mode.keepSynced',
        subtitleKey: 'settingsSession.handoff.workspaceMode.keepSyncedSubtitle',
    },
    {
        id: 'copy_once',
        titleKey: 'workspaceSync.mode.copyOnce',
        subtitleKey: 'settingsSession.handoff.workspaceMode.copyOnceSubtitle',
    },
    {
        id: 'none',
        titleKey: 'settingsSession.handoff.workspaceMode.noneTitle',
        subtitleKey: 'settingsSession.handoff.workspaceMode.noneSubtitle',
    },
    {
        id: 'mirror_exactly',
        titleKey: 'workspaceSync.mode.mirrorExactly',
        subtitleKey: 'settingsSession.handoff.workspaceMode.mirrorExactlySubtitle',
    },
    {
        id: 'keep_both_in_sync',
        titleKey: 'workspaceSync.mode.keepBothInSync',
        subtitleKey: 'settingsSession.handoff.workspaceMode.keepBothInSyncSubtitle',
    },
] as const satisfies readonly Readonly<{
    id: SessionHandoffWorkspaceMode;
    titleKey: string;
    subtitleKey: string;
}>[];

export const SESSION_HANDOFF_COMMON_WORKSPACE_SYNC_MODE_OPTIONS = SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS.filter(
    (option) => option.id === 'keep_synced' || option.id === 'copy_once' || option.id === 'none',
);

export const SESSION_HANDOFF_ADVANCED_WORKSPACE_SYNC_MODE_OPTIONS = SESSION_HANDOFF_WORKSPACE_SYNC_MODE_OPTIONS.filter(
    (option) => option.id === 'mirror_exactly' || option.id === 'keep_both_in_sync',
);

export const SESSION_HANDOFF_CONTENT_SELECTION_OPTIONS = [
    {
        id: 'git_worktree',
        titleKey: 'settingsSession.handoff.contentSelection.gitTitle',
        subtitleKey: 'settingsSession.handoff.contentSelection.gitSubtitle',
    },
    {
        id: 'all_files',
        titleKey: 'settingsSession.handoff.contentSelection.allFilesTitle',
        subtitleKey: 'settingsSession.handoff.contentSelection.allFilesSubtitle',
    },
] as const;

export const SESSION_HANDOFF_INCLUDE_IGNORED_MODE_OPTIONS = [
    {
        id: 'exclude',
        titleKey: 'settingsSession.handoff.includeIgnoredMode.excludeTitle',
        subtitleKey: 'settingsSession.handoff.includeIgnoredMode.excludeSubtitle',
    },
    {
        id: 'include_selected',
        titleKey: 'settingsSession.handoff.includeIgnoredMode.includeSelectedTitle',
        subtitleKey: 'settingsSession.handoff.includeIgnoredMode.includeSelectedSubtitle',
    },
] as const satisfies readonly Readonly<{
    id: SessionHandoffDefaultsV1['includeIgnoredMode'];
    titleKey: string;
    subtitleKey: string;
}>[];

export const SESSION_HANDOFF_DIRECT_TARGET_MODE_OPTIONS = [
    {
        id: 'keep_direct',
        titleKey: 'settingsSession.handoff.directTargetMode.keepDirectTitle',
        subtitleKey: 'settingsSession.handoff.directTargetMode.keepDirectSubtitle',
    },
    {
        id: 'convert_to_persisted',
        titleKey: 'settingsSession.handoff.directTargetMode.convertToPersistedTitle',
        subtitleKey: 'settingsSession.handoff.directTargetMode.convertToPersistedSubtitle',
    },
] as const satisfies readonly Readonly<{
    id: SessionHandoffDirectTargetMode;
    titleKey: string;
    subtitleKey: string;
}>[];

function normalizeWorkspaceMode(value: unknown): SessionHandoffWorkspaceMode {
    return typeof value === 'string' && (
        value === 'none'
        || value === 'copy_once'
        || value === 'keep_synced'
        || value === 'mirror_exactly'
        || value === 'keep_both_in_sync'
    )
        ? value
        : 'none';
}
/**
 * Normalize persisted presentation defaults. Legacy transfer fields are
 * deliberately ignored; they never get converted into a live workspace
 * operation. This keeps stale clients fail-closed at the daemon boundary.
 */
export function normalizeSessionHandoffDefaults(raw: unknown): SessionHandoffDefaultsV1 {
    const parsed = SessionHandoffDefaultsV1Schema.safeParse(raw);
    const candidate = parsed.success ? parsed.data : DEFAULT_SESSION_HANDOFF_DEFAULTS_V1;
    return {
        v: 1,
        workspaceSyncMode: normalizeWorkspaceMode(candidate.workspaceSyncMode),
        includeIgnoredMode: candidate.includeIgnoredMode === 'include_selected' ? 'include_selected' : 'exclude',
        ignoredIncludeGlobs: Array.isArray(candidate.ignoredIncludeGlobs)
            ? candidate.ignoredIncludeGlobs.filter((value): value is string => typeof value === 'string')
            : [],
        directTargetMode: candidate.directTargetMode === 'convert_to_persisted' ? 'convert_to_persisted' : 'keep_direct',
    };
}

export function parseSessionHandoffIgnoredIncludeGlobs(value: string): string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export function buildWorkspaceContentPolicy(args: Readonly<{
    contentSelection?: 'git_worktree' | 'all_files';
    includeIgnoredMode: SessionHandoffDefaultsV1['includeIgnoredMode'];
    ignoredIncludeGlobs: readonly string[];
}>): WorkspaceContentPolicyV1 {
    const base: Omit<WorkspaceContentPolicyV1, 'policyDigest'> = {
        v: 1,
        selection: args.contentSelection ?? 'git_worktree',
        extraIgnorePatterns: [],
        extraIncludePatterns: args.includeIgnoredMode === 'include_selected'
            ? [...args.ignoredIncludeGlobs]
            : [],
    };
    return {
        ...base,
        policyDigest: computeWorkspaceSyncPolicyDigest(base),
    };
}

/**
 * Construct the protocol action at the request boundary. Persistent modes
 * carry creation intent to the daemon, which exclusively owns relationship
 * identity, endpoint resolution, lifecycle and persistence.
 */
export function buildSessionHandoffWorkspaceAction(args: Readonly<{
    workspaceSyncRelationshipId?: string | null;
    workspaceSyncMode: SessionHandoffWorkspaceMode;
    contentSelection: 'git_worktree' | 'all_files';
    includeIgnoredMode: SessionHandoffDefaultsV1['includeIgnoredMode'];
    ignoredIncludeGlobs: readonly string[];
}>): HandoffWorkspaceActionV1 | undefined {
    const relationshipId = args.workspaceSyncRelationshipId?.trim();
    if (relationshipId) {
        return {
            kind: 'relationship',
            relationshipId,
            flushBeforeCommit: true,
        };
    }
    if (args.workspaceSyncMode === 'none') return { kind: 'none' };
    if (args.workspaceSyncMode === 'copy_once') {
        return {
            kind: 'copy_once',
            contentPolicy: buildWorkspaceContentPolicy(args),
        };
    }
    return {
        kind: 'create_relationship',
        mode: args.workspaceSyncMode,
        contentPolicy: buildWorkspaceContentPolicy(args),
        flushBeforeCommit: true,
    };
}
