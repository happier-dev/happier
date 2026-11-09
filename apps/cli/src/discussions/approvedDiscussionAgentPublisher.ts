import { DiscussionAgentPostPublicationV1Schema, DiscussionAgentPublisherResponseV1Schema, type DiscussionAgentPostPublicationV1,
  type DiscussionAgentPublisherRequestV1, type DiscussionAgentPublisherResponseV1 } from '@happier-dev/protocol/discussions/api';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { ApprovedDiscussionSourceActionExecute } from './approvedDiscussionPublication';
import { createDiscussionAgentPublisher } from './discussionAgentPublisher';
import type { RpcAdmissionPredicate } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { withApprovalActionTrace } from '@/daemon/externalActions/webLatencyTrace';

/** The daemon's recorded approval replay, independent of an invoking Agent turn. */
export function createApprovedDiscussionAgentPublisher(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverUrl: string;
  machineId: string;
  isApprovalExecutionOriginCurrent: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
  executeSourceAction?: ApprovedDiscussionSourceActionExecute;
  publish: (publication: DiscussionAgentPostPublicationV1, options?: Readonly<{ signal?: AbortSignal }>) => Promise<DiscussionAgentPublisherResponseV1>;
}>) {
  return async (request: DiscussionAgentPublisherRequestV1, options: Readonly<{
    approvedActionReplay: NonNullable<ActionExecutorContext['approvedActionReplay']>;
    callerAuthority?: ActionExecutorContext['authority'];
    requesterApprovalDecision?: ActionExecutorContext['requesterApprovalDecision'];
    signal?: AbortSignal;
  }>): Promise<DiscussionAgentPublisherResponseV1> => withApprovalActionTrace('approval.request.decide', async () => {
    const reportAdmissionDenial = (admissionPredicate: RpcAdmissionPredicate) => {
      logger.warnLocalFile('[Discussion approval replay] Publication refused', {
        artifactId: options.approvedActionReplay.artifactId,
        ...('operation' in request ? {} : { discussionId: request.discussionId }),
        sessionId: request.sessionId, admissionPredicate,
      });
    };
    const denied = () => ({ v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const });
    const accountId = readAccountIdFromToken(params.credentials.token);
    if ('operation' in request || options.callerAuthority !== 'present_user' || !accountId) {
      reportAdmissionDenial('session_authorization');
      return denied();
    }
    const sessionId = request.sessionId;
    const publish = createDiscussionAgentPublisher({
      serverId: params.serverId, serverUrl: params.serverUrl,
      machineId: params.machineId,
      readOwnerAccountCredentials: async () => params.credentials,
      isApprovalExecutionOriginCurrent: args => args.origin.machineId === params.machineId
        ? params.isApprovalExecutionOriginCurrent(args) : Promise.resolve(false),
      ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}),
      // This is retained publication custody, never a fabricated live turn or
      // Session transport. The same verifier above normalizes the approved body.
      session: { sessionId, postAgentDiscussionMessage: async (input, publicationOptions) => {
        if ('operation' in input || !input.draftReview) return denied();
        const publication = DiscussionAgentPostPublicationV1Schema.parse({ ...input, v: 1, sessionId });
        return await params.publish(publication, publicationOptions);
      } },
    });
    return DiscussionAgentPublisherResponseV1Schema.parse(await publish({ request,
      approvedActionReplay: options.approvedActionReplay }, {
      signal: options.signal ?? new AbortController().signal, callerAuthority: options.callerAuthority,
      reportAdmissionDenial,
      ...(options.requesterApprovalDecision ? { requesterApprovalDecision: options.requesterApprovalDecision } : {}),
    }));
  }, options.approvedActionReplay.artifactId);
}
