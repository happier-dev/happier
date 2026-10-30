import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionOrganizationContentEnvelopeSchema, type SessionOrganizationContentEnvelope } from '@happier-dev/protocol/sessions/organization/content';
import { CreateOrUpdateSessionOrganizationTagRequestSchema, DeleteSessionOrganizationTagRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { executeSessionSectionActionV1, isSessionSectionActionIdV1 } from '@happier-dev/protocol/actions/sessionSections';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { SessionOrganizationDisplayState } from '@/sync/domains/session/organization';
import { buildSessionOrganizationServerKey, buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { getStorage } from '@/sync/domains/state/storageStore';
import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { allocateSessionOrganizationFolderId, upsertSessionFolder } from './upsertSessionFolder';
import { upsertSessionTag } from './upsertSessionTag';
import { deleteSessionFolder } from './deleteSessionFolder';
import { deleteSessionTag } from './deleteSessionTag';
import { setSessionFolderAssignment } from './setSessionFolderAssignment';

export function isSessionOrganizationResourceAction(actionId: HomeDomainActionIdV1): boolean {
    return isSessionSectionActionIdV1(actionId) || ACTION_ID_FAMILIES_V1.session_organization_resources.some(id => id === actionId);
}

function projectDisplay<T extends Readonly<{ display: SessionOrganizationContentEnvelope | null; displayState: SessionOrganizationDisplayState }>>(row: T) {
    const { displayState, ...definition } = row;
    return {
        ...definition,
        display: row.display && displayState.status === 'available'
            ? SessionOrganizationContentEnvelopeSchema.parse({ t: 'plain', v: displayState.value }) : row.display,
        ...(displayState.status === 'locked' && (displayState.reason === 'invalid_stored_display' || displayState.reason === 'storage_mode_mismatch')
            ? { displayState: { status: 'unavailable' as const, reason: displayState.reason } } : {}),
    };
}

/** Action projection of the same live organization readers/writers used by UI. */
export function createSessionOrganizationResourceAction(account: LazyActionAccountContext): NonNullable<ActionExecutorDeps['homeDomainAction']> {
    return async ({ actionId, input, archiveSession }) => {
        account.assertCurrent();
        const params = { credentials: account.credentials, serverId: account.serverId,
            requestAtEndpoint: account.request, assertCurrent: account.assertCurrent };
        if (isSessionSectionActionIdV1(actionId)) {
            return await executeSessionSectionActionV1(actionId, input, {
                assertCurrent: account.assertCurrent,
                allocateFolderId: () => allocateSessionOrganizationFolderId(account.serverId),
                readSnapshot: async request => {
                    account.assertCurrent();
                    const state = getStorage().getState();
                    // Editing preserves omitted private display fields from the current opened
                    // definition. Assignments use the same admitted projection as a mounted move.
                    if (actionId === 'session.sections.update' && request.folderIds?.length) {
                        const folders = request.folderIds.map(id => state.sessionOrganizationFoldersByFolderKey[
                            buildSessionOrganizationServerKey(account.serverId, id)]);
                        if (folders.every(folder => folder !== undefined)) return { folders, folderAssignments: [] };
                    }
                    if (actionId === 'session.section.set' && request.assignmentSessionIds?.length === 1) {
                        const sessionId = request.assignmentSessionIds[0]!;
                        const assignment = state.sessionOrganizationFolderAssignmentsBySessionKey[
                            buildSessionOrganizationSessionKey(account.serverId, sessionId)];
                        if (assignment) return { folders: [], folderAssignments: assignment.folderId === null ? [] : [
                            { sessionId, folderId: assignment.folderId },
                        ] };
                    }
                    let snapshotReceived = false;
                    const snapshot = await fetchAndApplySessionOrganizationSnapshot({ ...params, request,
                        shouldContinue: account.accountLifetime.isCurrent,
                        onSnapshotReceived: () => { snapshotReceived = true; } });
                    account.assertCurrent();
                    if (!snapshot) throw new Error('action_account_scope_changed');
                    if (!snapshotReceived) return { ok: false, errorCode: 'section_membership_unavailable',
                        error: 'section_membership_unavailable' };
                    return snapshot;
                },
                upsertFolder: request => upsertSessionFolder({ ...params, request }),
                deleteFolder: request => deleteSessionFolder({ ...params, request }),
                setAssignment: (sessionId, folderId) => setSessionFolderAssignment({ ...params, sessionId, folderId }),
                archiveSession,
            });
        }
        let result: unknown;
        switch (actionId) {
            case 'session.tags.create': case 'session.tags.rename':
                result = { tag: projectDisplay(await upsertSessionTag({ ...params,
                    request: CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input) })) }; break;
            case 'session.tags.delete':
                result = await deleteSessionTag({ ...params, request: DeleteSessionOrganizationTagRequestSchema.parse(input) }); break;
            case 'session.tags.list': {
                const snapshot = await fetchAndApplySessionOrganizationSnapshot({ ...params,
                    shouldContinue: account.accountLifetime.isCurrent });
                account.assertCurrent();
                if (!snapshot) throw new Error('action_account_scope_changed');
                result = { snapshot: { ...snapshot, folders: snapshot.folders.map(projectDisplay),
                    tags: snapshot.tags.map(projectDisplay), labels: snapshot.labels.map(projectDisplay) } }; break;
            }
            default: return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        account.assertCurrent();
        return getActionSpec(actionId).outputSchema?.parse(result) ?? result;
    };
}
