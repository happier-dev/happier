import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectContextUpdateOutputV1Schema, type ProjectContextIntentV1 } from '@happier-dev/protocol/projects/projectContextV1';
import type { ProjectSourceAttachmentIntentV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import * as React from 'react';

import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useActiveServerAccountScope, useProjectOrganizations } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { readSourceTeamId } from '../sources/projectSourceGroups';
import { useProjectSources } from '../sources/useProjectSources';

const NO_ACCOUNT_SCOPE = { serverId: '', accountId: '' } as const;
const NO_ENTRIES: readonly PromptStackEntryV1[] = Object.freeze([]);

export type ProjectContextOutcome = 'applied' | 'pending' | 'conflict' | 'refused';
export type ProjectContextSharedStatus = 'none' | 'loading' | 'ready' | 'unavailable';

export type ProjectContextModel = Readonly<{
    serverId: string;
    /** The Team this Project's Source is shared with, when it has one and its name is known. */
    teamName: string | null;
    /** The Source layer: what every session anyone starts here reads. Absent for a Project with no Source. */
    shared: Readonly<{
        status: ProjectContextSharedStatus;
        entries: readonly PromptStackEntryV1[];
        /** This viewer may attach, detach, reorder and budget the Source's documents. */
        canManage: boolean;
        busy: boolean;
        update: (intent: ProjectSourceAttachmentIntentV1) => Promise<ProjectContextOutcome>;
        retry: () => void;
    }>;
    /** The viewer's own Project layer: only their sessions here read it. */
    personal: Readonly<{
        entries: readonly PromptStackEntryV1[];
        available: boolean;
        update: (intent: ProjectContextIntentV1) => Promise<ProjectContextOutcome>;
    }>;
}>;

function readPersonalOutcome(result: ActionExecuteResult): ProjectContextOutcome {
    if (!result.ok) return 'refused';
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return 'pending';
    const output = ProjectContextUpdateOutputV1Schema.safeParse(result.result);
    if (!output.success) return 'refused';
    if (output.data.ok) return 'applied';
    return output.data.errorCode === 'project_context_conflict' ? 'conflict' : 'refused';
}

/**
 * The two Project layers of Context for one Project (plan 65 §2; lab `c-ctx` P/R), read from their
 * owners and written only through their Actions: the Source's `context` attachments
 * (`projects.sources.update`, for those who can manage the Source) and the viewer's own organization
 * row (`projects.context.update`). The same data `readUiSessionProjectPromptStack` hands a session's
 * preparation, in the same order: shared first, then personal.
 */
export function useProjectContext(workspaceRef: WorkspaceRefV1): ProjectContextModel {
    const serverId = workspaceRef.serverId;
    const scope = useActiveServerAccountScope(serverId);
    const project = React.useMemo(() => projectWorkspaceRefV1(workspaceRef), [workspaceRef]);
    const organizations = useProjectOrganizations();
    const row = React.useMemo(
        () => organizations.find((candidate) => candidate.key.serverId === project.serverId && candidate.key.projectKey === project.projectKey) ?? null,
        [organizations, project.projectKey, project.serverId],
    );
    const sourceId = workspaceRef.source?.sourceId ?? null;
    const sources = useProjectSources(scope ?? NO_ACCOUNT_SCOPE, { enabled: sourceId !== null && scope !== null });
    const controller = sources.controller;
    React.useEffect(() => {
        if (sourceId && scope) void controller.select(sourceId);
    }, [controller, scope, sourceId]);
    const state = sources.state;
    const source = sourceId && state.current?.id === sourceId ? state.current : null;
    const teamId = source ? readSourceTeamId(source) : null;
    const teamServerIds = React.useMemo(() => [serverId], [serverId]);
    const teams = useTeamsDirectory({ serverIds: teamServerIds, enabled: teamId !== null });
    const teamName = teamId ? (teams.rows.find((candidate) => candidate.team.id === teamId)?.team.name ?? null) : null;

    const sharedEntries = React.useMemo(
        () => (source?.attachments ?? []).flatMap((attachment) => (attachment.purpose === 'context' ? [attachment.entry] : [])),
        [source?.attachments],
    );
    const updateShared = React.useCallback(async (intent: ProjectSourceAttachmentIntentV1): Promise<ProjectContextOutcome> => {
        const result = await controller.updateSource({ attachment: intent });
        if (!result) return 'refused';
        if (result.ok) return 'applied';
        return result.error === 'source_conflict' ? 'conflict' : 'refused';
    }, [controller]);
    const retryShared = React.useCallback(() => { void controller.refresh({ detailOnly: true }); }, [controller]);

    const revision = row?.revision ?? 'absent';
    const accountId = scope?.accountId ?? null;
    const updatePersonal = React.useCallback(async (intent: ProjectContextIntentV1): Promise<ProjectContextOutcome> => {
        if (!accountId) return 'refused';
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        return readPersonalOutcome(await createDefaultActionExecutor().execute('projects.context.update', {
            target: { serverId: project.serverId, projectKey: project.projectKey },
            expectedRevision: revision,
            intent,
        }, { surface: 'ui', authority: 'present_user', serverId: project.serverId, expectedAccountId: accountId }));
    }, [accountId, project.projectKey, project.serverId, revision]);

    const sharedStatus: ProjectContextSharedStatus = !sourceId ? 'none'
        : source ? 'ready'
            : state.detailStatus === 'offline' || state.detailStatus === 'refused' ? 'unavailable' : 'loading';
    const personalEntries = row?.value.promptStack ?? NO_ENTRIES;
    return React.useMemo((): ProjectContextModel => ({
        serverId,
        teamName,
        shared: {
            status: sharedStatus,
            entries: sharedEntries,
            canManage: sharedStatus === 'ready' && state.canManage,
            busy: state.mutation !== 'idle',
            update: updateShared,
            retry: retryShared,
        },
        personal: { entries: personalEntries, available: accountId !== null, update: updatePersonal },
    }), [accountId, personalEntries, retryShared, serverId, sharedEntries, sharedStatus, state.canManage, state.mutation, teamName, updatePersonal, updateShared]);
}
