import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getStorage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import type { AutomationSubjectContextV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { LazyActionAccountContext } from './actionAccountContext';

/** The existing origin-fact port reads the captured Account's exact cached Session. */
export function createUiActionExecutionOriginContextPreparer(
    account: Pick<LazyActionAccountContext, 'serverId' | 'serverIdentityId'> | null | undefined,
): NonNullable<ActionExecutorDeps['prepareApprovalExecutionOriginContext']> {
    return async ({ targetSessionId }) => {
        const subjects: AutomationSubjectContextV1[] = [];
        if (targetSessionId && account?.serverId && account.serverIdentityId) {
            const state = getStorage().getState();
            const full = state.sessions[targetSessionId];
            const exactFull = full && areServerProfileIdentifiersEquivalent(full.serverId, account.serverId) ? full : null;
            const row = exactFull ? null : readSessionListRowForServerId(state.sessionListRowsByServerId, account.serverId, targetSessionId);
            const projectKey = exactFull?.projectKey ?? row?.projectKey;
            const metadata = exactFull ? readSessionOwnerMetadataView(exactFull) : row ? readSessionListRenderableOwnerMetadataView(row) : null;
            const machineId = resolveSessionMachineId(metadata);
            if (projectKey) subjects.push({ role: 'context', subject: { kind: 'project', serverId: account.serverIdentityId, projectKey } });
            if (machineId) subjects.push({ role: 'context', subject: { kind: 'machine', serverId: account.serverIdentityId, machineId } });
        }
        return {
            ...(account?.serverIdentityId ? { serverIdentityId: account.serverIdentityId } : {}),
            ...(targetSessionId ? { defaultSessionMachineId: readMachineControlTargetForSession(account?.serverId
                ? { sessionId: targetSessionId, serverId: account.serverId } : targetSessionId)?.machineId ?? '' } : {}),
            ...(subjects.length ? { automationSubjects: subjects } : {}),
        };
    };
}
