import * as React from 'react';

import { SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS } from '@happier-dev/protocol/sessions/organization/constants';
import { Modal } from '@/modal';
import { SessionSectionResultV1Schema } from '@happier-dev/protocol/actions/sessionSections';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { openSessionFolderSelection } from '@/components/sessions/organization/SessionFolderSelection';
import { requestSessionSectionName } from '@/components/sessions/organization/sessionSectionEditing';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import { projectSessionOrganizationSections } from '@/sync/domains/session/organization/sections';
import type { UiSessionOrganizationFolder } from '@/sync/domains/session/organization/types';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization/fetchSessionOrganizationSnapshot';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';

async function readWorkflowSections(
    lifetime: ServerAccountScopeLifetime,
    assignmentIds?: readonly string[],
    signal?: AbortSignal,
) {
    const account = await captureLazyActionAccountContext(lifetime.scope.serverId, signal, undefined, lifetime.scope);
    try {
        await fetchAndApplySessionOrganizationSnapshot({
            credentials: account.credentials, serverId: account.serverId, requestAtEndpoint: account.request,
            request: assignmentIds === undefined ? { entityKind: 'workflow', includeAllFolderAssignments: true, includeFolders: true }
                : { entityKind: 'workflow', assignmentEntityIds: [...assignmentIds], includeFolders: false },
            shouldContinue: () => lifetime.isCurrent() && !signal?.aborted,
        });
    } finally {
        account.dispose();
    }
}

function projectWorkflowSections(serverId: string, folders: Readonly<Record<string, UiSessionOrganizationFolder>>) {
    return projectSessionOrganizationSections(serverId, {
        foldersById: Object.fromEntries(Object.values(folders).filter(folder =>
            folders[buildSessionOrganizationServerKey(serverId, folder.folderId)] === folder).map(folder => [folder.folderId, folder])),
    });
}

/** Workflow memberships in the same Account sections used by Sessions. */
export function useWorkflowSections(focused: boolean, lifetime: ServerAccountScopeLifetime | null, ids: readonly string[]) {
    const serverId = lifetime?.scope.serverId ?? null;
    const demanded = focused && ids.length > 0;
    const store = getStorage();
    const folders = store(state => state.sessionOrganizationFoldersByFolderKey);
    const assignments = store(state => serverId === null ? undefined : state.organizationWorkflowFolderAssignmentsByServerId[serverId]);
    const sections = React.useMemo(() => serverId === null ? [] : projectWorkflowSections(serverId, folders), [serverId, folders]);
    const { executeValue } = useMountedActionExecution(lifetime?.scope);
    React.useEffect(() => {
        if (!demanded || !lifetime) return;
        let pending: { controller: AbortController; ids?: readonly string[] } | undefined;
        const refresh = (changedIds?: readonly string[]) => {
            if (!lifetime.isCurrent()) return;
            const haveAssignments = store.getState().organizationWorkflowFolderAssignmentsByServerId[lifetime.scope.serverId] !== undefined;
            let ids: readonly string[] | undefined;
            if (changedIds && haveAssignments && (!pending || pending.ids)) {
                const combined = [...new Set([...(pending?.ids ?? []), ...changedIds])];
                if (combined.length <= SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS) ids = combined;
            }
            pending?.controller.abort();
            const attempt = { controller: new AbortController(), ids };
            pending = attempt;
            void readWorkflowSections(lifetime, ids, attempt.controller.signal).catch(() => {
                // Keep admitted memberships. Move offers retry if no snapshot has settled.
            }).finally(() => { if (pending === attempt) pending = undefined; });
        };
        const unsubscribe = subscribeHomeAccountChange(event => {
            const changes = event.workflowSectionChanges;
            if (event.entityIds === undefined || event.source === 'connected' || event.source === 'snapshot'
                || changes === 'all' || (changes === undefined && event.entityIds.includes('session-organization'))) refresh();
            else if (changes && changes !== 'none') refresh(changes);
        }, { serverIds: [lifetime.scope.serverId], reconnect: 'refresh', includeCatchUpPending: 'recovery' });
        const retirement = lifetime.onRetire(() => { pending?.controller.abort(); unsubscribe(); });
        refresh();
        return () => { retirement.dispose(); pending?.controller.abort(); unsubscribe(); };
    }, [demanded, lifetime, store]);

    const assignmentFor = React.useCallback((id: string) => assignments === undefined ? undefined
        : Object.hasOwn(assignments, id) ? assignments[id] ?? null : null, [assignments]);
    const moveWorkflow = useEventCallback(async (id: string, sourceLabel: string) => {
        if (!serverId || !lifetime?.isCurrent()) return;
        let current = assignmentFor(id);
        if (current === undefined) {
            const retry = await Modal.confirm(t('sessionsList.moveToFolder'), t('common.unavailable'), { confirmText: t('common.retry') });
            if (!retry || !lifetime.isCurrent()) return;
            await readWorkflowSections(lifetime);
            if (!lifetime.isCurrent()) return;
            const refreshed = store.getState().organizationWorkflowFolderAssignmentsByServerId[serverId];
            if (refreshed === undefined) return;
            current = Object.hasOwn(refreshed, id) ? refreshed[id] ?? null : null;
        }
        const selected = await openSessionFolderSelection({
            sourceLabel, serverId,
            sections: projectWorkflowSections(serverId, store.getState().sessionOrganizationFoldersByFolderKey),
            value: current === null ? null : { serverId, sectionId: current },
            unassignedLabel: t('common.none'),
            onCreate: async () => {
                const name = await requestSessionSectionName(null);
                if (!name || !lifetime.isCurrent()) return null;
                const created = SessionSectionResultV1Schema.parse(await executeValue('session.sections.create', { name }));
                return { serverId, sectionId: created.section.sectionId };
            },
        });
        if (selected === undefined || !lifetime.isCurrent()) return;
        await executeValue('session.section.set', { entityKind: 'workflow', entityId: id, sectionId: selected?.sectionId ?? null });
    });
    const [, move] = useHappyAction(moveWorkflow);
    // "New section" from the View menu (scene 8): the same naming prompt and Action the move's own "New section" uses.
    const createSection = useEventCallback(async () => {
        if (!lifetime?.isCurrent()) return;
        const name = await requestSessionSectionName(null);
        if (!name || !lifetime.isCurrent()) return;
        await executeValue('session.sections.create', { name });
    });
    const [, create] = useHappyAction(createSection);
    return React.useMemo(() => ({ sections, assignmentFor, move, create }), [sections, assignmentFor, move, create]);
}
