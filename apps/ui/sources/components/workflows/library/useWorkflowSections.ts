import * as React from 'react';

import { SessionSectionResultV1Schema } from '@happier-dev/protocol/actions/sessionSections';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { openSessionFolderSelection } from '@/components/sessions/organization/SessionFolderSelection';
import { requestSessionSectionName } from '@/components/sessions/organization/sessionSectionEditing';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization/keys';
import { projectSessionOrganizationSections } from '@/sync/domains/session/organization/sections';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization/fetchSessionOrganizationSnapshot';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';

/** Workflow memberships in the same Account sections used by Sessions. */
export function useWorkflowSections(focused: boolean, lifetime: ServerAccountScopeLifetime | null, ids: readonly string[]) {
    const serverId = lifetime?.scope.serverId ?? null;
    const demanded = focused && ids.length > 0;
    const store = getStorage();
    const folders = store(state => state.sessionOrganizationFoldersByFolderKey);
    const assignments = store(state => serverId === null ? undefined : state.organizationWorkflowFolderAssignmentsByServerId[serverId]);
    const sections = React.useMemo(() => serverId === null ? [] : projectSessionOrganizationSections(serverId, {
        foldersById: Object.fromEntries(Object.values(folders).filter(folder =>
            folders[buildSessionOrganizationServerKey(serverId, folder.folderId)] === folder).map(folder => [folder.folderId, folder])),
    }), [serverId, folders]);
    const { executeValue } = useMountedActionExecution(lifetime?.scope);
    React.useEffect(() => {
        if (!demanded || !lifetime) return;
        let pending: AbortController | undefined;
        const refresh = () => {
            pending?.abort();
            const attempt = new AbortController();
            pending = attempt;
            const shouldContinue = () => lifetime.isCurrent() && !attempt.signal.aborted;
            void (async () => {
                const account = await captureLazyActionAccountContext(lifetime.scope.serverId, undefined, undefined, lifetime.scope);
                try {
                    await fetchAndApplySessionOrganizationSnapshot({
                        credentials: account.credentials, serverId: account.serverId, requestAtEndpoint: account.request,
                        request: { entityKind: 'workflow', includeAllFolderAssignments: true, includeFolders: true },
                        shouldContinue,
                    });
                } finally { account.dispose(); }
            })().catch(() => { /* Keep admitted memberships. Focus or the next Home wake refreshes them. */ });
        };
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (event.source === 'connected' || event.source === 'snapshot' || event.entityIds?.includes('session-organization')) refresh();
        }, { serverIds: [lifetime.scope.serverId], reconnect: 'refresh' });
        refresh();
        return () => { pending?.abort(); unsubscribe(); };
    }, [demanded, lifetime]);

    const assignmentFor = React.useCallback((id: string) => assignments === undefined ? undefined
        : Object.hasOwn(assignments, id) ? assignments[id] ?? null : null, [assignments]);
    const moveWorkflow = useEventCallback(async (id: string, sourceLabel: string) => {
        const current = assignmentFor(id);
        if (!serverId || current === undefined || !lifetime?.isCurrent()) return;
        const selected = await openSessionFolderSelection({
            sourceLabel, serverId, sections, value: current === null ? null : { serverId, sectionId: current },
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
