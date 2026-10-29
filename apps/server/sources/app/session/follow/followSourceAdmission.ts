import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { resolveDiscussionContextInTx } from '@/app/discussions/access';
import { resolveWorkflowRunAccessInTx } from '@/app/workflows/workflowRunAccess';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { MachineAdmission } from '@happier-dev/protocol/machines/machineAccessV1';

type FollowContentSource = Exclude<FollowSourceRefV1, { kind: 'rule' }>;

/** Keep the source read and its captured Machine custody on one admission. */
export async function readExecutionRunFollowMachineAdmissionInTx(tx: Tx, input: Readonly<{
    accountId: string; machineId: string; authentication: SessionAccessAuthentication;
}>): Promise<Extract<MachineAdmission, { kind: 'admitted' }> | null> {
    if (input.authentication.sessionRuntimePrincipal || input.authentication.apiTokenGrant?.targets != null) return null;
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.accountId,
        machineId: input.machineId, rpcMethod: SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER });
    return admission.kind === 'admitted' ? admission : null;
}

/** A Follow ref is readable only through its current source owner. */
export async function canReadFollowSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; source: FollowContentSource; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    const source = input.source;
    if (source.kind === 'execution_run' && 'machineId' in source) {
        return await readExecutionRunFollowMachineAdmissionInTx(tx, { ...input, machineId: source.machineId }) !== null;
    }
    if (source.kind === 'session' || source.kind === 'execution_run') {
        return (await resolveEffectiveSessionAccess(tx, { accountId: input.accountId,
            sessionId: source.sessionId, authentication: input.authentication }))?.capabilities.readTranscript === true;
    }
    if (source.kind === 'discussion') return await resolveDiscussionContextInTx(tx, {
        discussionId: source.discussionId, accountId: input.accountId,
        authentication: input.authentication }) !== null;
    if (input.authentication.apiTokenGrant?.targets != null) return false;
    return await resolveWorkflowRunAccessInTx(tx, { actorAccountId: input.accountId, runId: source.runId }) !== null;
}
