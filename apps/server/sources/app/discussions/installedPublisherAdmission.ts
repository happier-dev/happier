import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { resolveMachineAdmissionInTx } from '@/app/machines/machineAccess';
import { hasCurrentSessionActionRpcSourceBindingInTx } from '@/app/api/socket/sessionScopedBinding';
import { isSessionInputSourceCurrentInTx } from '@/app/session/messages/sessionMessageReply';
import type { Tx } from '@/storage/inTx';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

/** Socket and signed-upload carriers share installed publisher custody and currentness. */
export async function admitInstalledDiscussionPublisherInTx(tx: Tx, input: Readonly<{
    accountId: string; machineId: string; installationId: string;
    source?: Readonly<{ sessionId: string; sourceSession?: SessionInputSourceSessionV1 }>;
    lockAuthority?: true;
}>): Promise<DiscussionResult<undefined>> {
    // Commit callers acquire the canonical Machine/AccessKey locks before
    // reading admission facts; byte preparation never grants commit authority.
    if (input.source && !await hasCurrentSessionActionRpcSourceBindingInTx(tx, {
        accountId: input.accountId, machineId: input.machineId, installationId: input.installationId,
        sourceSessionId: input.source.sessionId,
        ...(input.lockAuthority ? { lockAuthority: true } : {}),
    })) return discussionFailure('discussion_post_denied');
    const admission = await resolveMachineAdmissionInTx(tx, { actorAccountId: input.accountId, machineId: input.machineId });
    if (admission.kind !== 'admitted') return discussionFailure(admission.code);
    if (admission.custodianAccountId !== input.accountId) return discussionFailure('discussion_machine_custodian_mismatch');
    if (admission.installationId !== input.installationId) return discussionFailure('discussion_machine_installation_mismatch');
    if (input.source) {
        const session = await tx.session.findUnique({ where: { id: input.source.sessionId }, select: { archivedAt: true } });
        if (!session || session.archivedAt || input.source.sourceSession
            && (input.source.sourceSession.sourceSessionId !== input.source.sessionId
                || !await isSessionInputSourceCurrentInTx(tx, input.accountId, input.source.sourceSession))) {
            return discussionFailure('discussion_post_denied');
        }
    }
    return discussionSuccess(undefined);
}
