import type { SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';
import { z } from 'zod';

export type SessionHandoffDirectTargetMode = 'keep_direct' | 'convert_to_persisted';

export type SessionHandoffDefaultsV1 = Readonly<{
    v: 1;
    workspaceTransferEnabled: boolean;
    workspaceTransferStrategy: SessionHandoffWorkspaceTransfer['strategy'];
    conflictPolicy: SessionHandoffWorkspaceTransfer['conflictPolicy'];
    includeIgnoredMode: SessionHandoffWorkspaceTransfer['includeIgnoredMode'];
    ignoredIncludeGlobs: readonly string[];
    directTargetMode: SessionHandoffDirectTargetMode;
}>;

export const SessionHandoffDefaultsV1Schema = z.object({
    v: z.literal(1).default(1),
    workspaceTransferEnabled: z.boolean().default(false),
    workspaceTransferStrategy: z.enum(['transfer_snapshot', 'sync_changes']).default('transfer_snapshot'),
    conflictPolicy: z.enum(['create_sibling_copy', 'replace_existing']).default('create_sibling_copy'),
    includeIgnoredMode: z.enum(['exclude', 'include_selected']).default('exclude'),
    ignoredIncludeGlobs: z.array(z.string()).default([]),
    directTargetMode: z.enum(['keep_direct', 'convert_to_persisted']).default('keep_direct'),
});

export const DEFAULT_SESSION_HANDOFF_DEFAULTS_V1: SessionHandoffDefaultsV1 = Object.freeze({
    v: 1,
    workspaceTransferEnabled: false,
    workspaceTransferStrategy: 'transfer_snapshot',
    conflictPolicy: 'create_sibling_copy',
    includeIgnoredMode: 'exclude',
    ignoredIncludeGlobs: [],
    directTargetMode: 'keep_direct',
});

export const SESSION_HANDOFF_CONFLICT_POLICY_OPTIONS = [
    {
        id: 'create_sibling_copy',
        titleKey: 'settingsSession.handoff.conflictPolicy.createSiblingCopyTitle',
        subtitleKey: 'settingsSession.handoff.conflictPolicy.createSiblingCopySubtitle',
    },
    {
        id: 'replace_existing',
        titleKey: 'settingsSession.handoff.conflictPolicy.replaceExistingTitle',
        subtitleKey: 'settingsSession.handoff.conflictPolicy.replaceExistingSubtitle',
    },
] as const satisfies readonly Readonly<{
    id: SessionHandoffWorkspaceTransfer['conflictPolicy'];
    titleKey: string;
    subtitleKey: string;
}>[];

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
    id: SessionHandoffWorkspaceTransfer['includeIgnoredMode'];
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

export const SESSION_HANDOFF_WORKSPACE_TRANSFER_STRATEGY_OPTIONS = [
    {
        id: 'transfer_snapshot',
        titleKey: 'settingsSession.handoff.workspaceTransfer.strategy.transferSnapshotTitle',
        subtitleKey: 'settingsSession.handoff.workspaceTransfer.strategy.transferSnapshotSubtitle',
    },
    {
        id: 'sync_changes',
        titleKey: 'settingsSession.handoff.workspaceTransfer.strategy.syncChangesTitle',
        subtitleKey: 'settingsSession.handoff.workspaceTransfer.strategy.syncChangesSubtitle',
    },
] as const satisfies readonly Readonly<{
    id: SessionHandoffWorkspaceTransfer['strategy'];
    titleKey: string;
    subtitleKey: string;
}>[];

export function normalizeSessionHandoffDefaults(raw: unknown): SessionHandoffDefaultsV1 {
    const candidate = raw as Partial<SessionHandoffDefaultsV1> | null | undefined;
    const workspaceTransferStrategy =
        candidate?.workspaceTransferStrategy === 'sync_changes' ? 'sync_changes' : 'transfer_snapshot';
    return {
        v: 1,
        workspaceTransferEnabled: candidate?.workspaceTransferEnabled === true,
        workspaceTransferStrategy,
        conflictPolicy:
            workspaceTransferStrategy === 'sync_changes'
                ? 'replace_existing'
                : candidate?.conflictPolicy === 'replace_existing'
                    ? 'replace_existing'
                    : 'create_sibling_copy',
        includeIgnoredMode: candidate?.includeIgnoredMode === 'include_selected' ? 'include_selected' : 'exclude',
        ignoredIncludeGlobs: Array.isArray(candidate?.ignoredIncludeGlobs)
            ? candidate.ignoredIncludeGlobs.filter((value): value is string => typeof value === 'string')
            : [],
        directTargetMode: candidate?.directTargetMode === 'convert_to_persisted' ? 'convert_to_persisted' : 'keep_direct',
    };
}

export function parseSessionHandoffIgnoredIncludeGlobs(value: string): string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

export function buildSessionHandoffWorkspaceTransfer(args: Readonly<{
    workspaceTransferEnabled: boolean;
    workspaceTransferStrategy: SessionHandoffWorkspaceTransfer['strategy'];
    conflictPolicy: SessionHandoffWorkspaceTransfer['conflictPolicy'];
    includeIgnoredMode: SessionHandoffWorkspaceTransfer['includeIgnoredMode'];
    ignoredIncludeGlobs: readonly string[];
}>): SessionHandoffWorkspaceTransfer | undefined {
    if (!args.workspaceTransferEnabled) return undefined;
    const conflictPolicy =
        args.workspaceTransferStrategy === 'sync_changes'
            ? 'replace_existing'
            : args.conflictPolicy;
    return {
        enabled: args.workspaceTransferEnabled,
        strategy: args.workspaceTransferStrategy,
        conflictPolicy,
        includeIgnoredMode: args.includeIgnoredMode,
        ignoredIncludeGlobs: [...args.ignoredIncludeGlobs],
    };
}
