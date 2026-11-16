import tweetnacl from 'tweetnacl';
import { buildApprovalExecutionOriginV1, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalRequestV2Schema, buildApprovalRequesterConfirmationV1, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/references';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

import type { DecryptedArtifact } from './artifactTypes';

/**
 * A shared Bot's requester-bound approval produced by the real Protocol owners: the requester subject
 * and the signed original execution origin, with the admitted cause pointing at a Discussion message.
 * Only the installation key (a real crypto boundary) is a fixed test seed.
 */
export function buildDiscussionRequesterApprovalArtifact(input: Readonly<{
    id?: string;
    serverId?: string;
    serverIdentityId?: string;
    discussionId?: string;
    originMessageId?: string;
    requestRef?: string;
    requesterAccountId?: string;
    executionAccountId?: string;
    botSessionId?: string;
    origin?: CoordinationMessageRefV1 | null;
    summary?: string;
    preview?: unknown;
    actionId?: 'session.title.set' | 'session.stop' | 'doc.edit.propose' | 'discussion.post';
    actionArgs?: unknown;
    settle?: (request: ApprovalRequestV2) => ApprovalRequestV2;
}> = {}): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const serverId = input.serverId ?? 'server-1';
    const serverIdentityId = input.serverIdentityId ?? 'stable-home';
    const botSessionId = input.botSessionId ?? 's1';
    const executionAccountId = input.executionAccountId ?? 'alice';
    const requestRef = input.requestRef ?? 'bob-input';
    const actionId = input.actionId ?? 'session.title.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse(input.actionArgs
        ?? (actionId === 'doc.edit.propose' ? {
            discussionRef: { serverId, discussionId: input.discussionId ?? 'discussion-1' }, localId: 'redo-proposal',
            target: { ref: { kind: 'doc', artifactId: 'doc-1' }, revision: { headerVersion: 1, bodyVersion: 3 },
                range: { start: 0, end: 7 }, quote: 'Current' },
            baseRevision: { headerVersion: 1, bodyVersion: 3 }, before: 'Current', after: 'Revised', reason: 'Redo against the current passage',
        } : actionId === 'discussion.post' ? {
            discussionId: input.discussionId ?? 'discussion-1', localId: 'own-reply',
            content: { v: 1, parts: [{ t: 'text', text: 'Revised suggestion' }] },
        } : actionId === 'session.stop' ? { sessionId: botSessionId } : { sessionId: botSessionId, title: 'Release 0.3' }));
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39));
    const caller = { kind: 'session' as const, sessionId: botSessionId, starterDepth: 0, turnDepth: 0 };
    const target = { kind: 'session' as const, sessionId: botSessionId };
    const actionRequestAttributionV1 = {
        requestRef,
        requester: { serverId, accountId: input.requesterAccountId ?? 'bob' },
        persona: { serverId, sessionId: botSessionId },
        origin: input.origin !== undefined ? input.origin : {
            kind: 'discussion' as const,
            discussion: { serverId, discussionId: input.discussionId ?? 'discussion-1' },
            messageId: input.originMessageId ?? 'message-ask',
        },
    };
    const context: ActionExecutorContext = {
        surface: 'agent', authority: 'account_automation', runtimeAccountId: executionAccountId,
        defaultSessionId: botSessionId, serverId, serverIdentityId, actionRequestId: 'action-1',
        actionCaller: caller, callerPermissionMode: 'yolo',
        sessionInputSource: { sourceSessionId: botSessionId, sourceTurnId: 'turn-1', via: 'action' },
        externalActionTarget: target,
        externalActionExecutionAuthorization: { v: 1, token: 'home-admitted-source', binding: {
            serverIdentityId, accountId: executionAccountId, custodianAccountId: executionAccountId,
            machineId: 'machine-1', installationId: 'installation', actionId, requestId: 'action-1', target,
            authentication: { kind: 'account', tokenEpoch: 0 },
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'action-1', target, input: projectNativeJsonValueForTransport(actionArgs) }),
            sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', requestId: 'action-1', actionRequestAttributionV1 },
            sessionActionSource: { machineId: 'machine-1', installationId: 'installation' },
        } },
        signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
            actionId: args.actionId, target: args.target, input: args.input, privateKey: key.secretKey,
            requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
        actionRequestAttributionV1,
    };
    const requesterConfirmation = buildApprovalRequesterConfirmationV1({ context, actionId, input: actionArgs });
    if (!requesterConfirmation && (input.requesterAccountId ?? 'bob') !== executionAccountId) throw new Error('Expected the admitted requester confirmation');
    const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input: actionArgs, context, targetSessionId: botSessionId, requesterConfirmation: requesterConfirmation ?? undefined });
    if (!executionOriginV1) throw new Error('Expected the signed original Bot execution origin');
    const open = ApprovalRequestV2Schema.parse({
        v: 2, status: 'open', createdAtMs: 10, updatedAtMs: 10,
        createdBy: { surface: 'agent', sessionId: botSessionId }, requestedSurface: 'agent',
        executionOriginV1, ...(requesterConfirmation ? { requesterConfirmation } : {}), actionId, actionArgs,
        summary: input.summary ?? 'Rename the session to Release 0.3',
        ...(input.preview !== undefined ? { preview: input.preview } : {}),
    });
    const request = input.settle ? ApprovalRequestV2Schema.parse(input.settle(open)) : open;
    const header = buildApprovalRequestArtifactHeaderV1(request);
    return {
        id: input.id ?? 'requester-approval-1', header, title: typeof header.title === 'string' ? header.title : null,
        sessions: Array.isArray(header.sessions) ? header.sessions as string[] : undefined,
        body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 10, updatedAt: 10, isDecrypted: true,
    };
}
