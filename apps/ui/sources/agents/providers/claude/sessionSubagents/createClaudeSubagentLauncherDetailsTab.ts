import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { t } from '@/text';

export type ClaudeSubagentLauncherMode = 'team' | 'member';

export type ClaudeSubagentLauncherResource = Readonly<{
    kind: 'claudeSubagentLauncher';
    mode: ClaudeSubagentLauncherMode;
    initialTeamId?: string;
}>;

export function isClaudeSubagentLauncherResource(value: unknown): value is ClaudeSubagentLauncherResource {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; mode?: unknown; initialTeamId?: unknown };
    if (maybe.kind !== 'claudeSubagentLauncher') return false;
    if (maybe.mode !== 'team' && maybe.mode !== 'member') return false;
    return maybe.initialTeamId == null || typeof maybe.initialTeamId === 'string';
}

export function createClaudeSubagentLauncherDetailsTab(
    mode: ClaudeSubagentLauncherMode,
    initialTeamId?: string | null,
): DetailsTab {
    const normalizedTeamId = typeof initialTeamId === 'string' && initialTeamId.trim().length > 0
        ? initialTeamId.trim()
        : null;

    return {
        key: mode === 'member' && normalizedTeamId
            ? `claude-subagent-launcher:member:${normalizedTeamId}`
            : `claude-subagent-launcher:${mode}`,
        kind: 'claudeSubagentLauncher',
        title: mode === 'member'
            ? t('session.subagents.panel.launchTeammateAction')
            : t('session.subagents.panel.launchClaudeTeamAction'),
        subtitle: t('session.subagents.panel.launchClaudeTeamsSubtitle'),
        resource: {
            kind: 'claudeSubagentLauncher',
            mode,
            ...(normalizedTeamId ? { initialTeamId: normalizedTeamId } : {}),
        },
    };
}
