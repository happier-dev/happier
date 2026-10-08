import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionOrganizationContentEnvelopeSchema, type SessionOrganizationContentEnvelope } from '@happier-dev/protocol/sessions/organization/content';
import { CreateOrUpdateSessionOrganizationFolderRequestSchema, CreateOrUpdateSessionOrganizationTagRequestSchema, DeleteSessionOrganizationFolderRequestSchema, DeleteSessionOrganizationTagRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { HomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { SessionOrganizationDisplayState } from '@/sync/domains/session/organization';
import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { upsertSessionFolder } from './upsertSessionFolder';
import { upsertSessionTag } from './upsertSessionTag';
import { deleteSessionFolder } from './deleteSessionFolder';
import { deleteSessionTag } from './deleteSessionTag';
import { setSessionFolderAssignment } from './setSessionFolderAssignment';

export function isSessionOrganizationResourceAction(actionId: HomeDomainActionIdV1): boolean {
    return actionId === 'session.folder.set' || ACTION_ID_FAMILIES_V1.session_organization_resources.some(id => id === actionId);
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
    return async ({ actionId, input }) => {
        account.assertCurrent();
        const params = { credentials: account.credentials, serverId: account.serverId,
            requestAtEndpoint: account.request, assertCurrent: account.assertCurrent };
        let result: unknown;
        switch (actionId) {
            case 'session.folder.set': {
                // The published Action schema validates both fields; its catalog type is action-agnostic.
                const request = getActionSpec(actionId).inputSchema.parse(input) as Readonly<{ sessionId: string; folderId: string | null }>;
                result = await setSessionFolderAssignment({ ...params, ...request });
                break;
            }
            case 'session.folders.create': case 'session.folders.rename':
                result = { folder: projectDisplay(await upsertSessionFolder({ ...params,
                    request: CreateOrUpdateSessionOrganizationFolderRequestSchema.parse(input) })) }; break;
            case 'session.tags.create': case 'session.tags.rename':
                result = { tag: projectDisplay(await upsertSessionTag({ ...params,
                    request: CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input) })) }; break;
            case 'session.folders.delete':
                result = await deleteSessionFolder({ ...params, request: DeleteSessionOrganizationFolderRequestSchema.parse(input) }); break;
            case 'session.tags.delete':
                result = await deleteSessionTag({ ...params, request: DeleteSessionOrganizationTagRequestSchema.parse(input) }); break;
            case 'session.folders.list': case 'session.tags.list': {
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
