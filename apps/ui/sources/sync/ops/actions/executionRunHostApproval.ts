import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExecutionRunHostActionApprovalSettlementV1Schema, StoredExecutionRunHostActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ArtifactBodyV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';

/** The UI transports consent; only the original Session host releases current intent. */
export function createExecutionRunHostApprovalReplay(deps: Readonly<{
    read: (artifactId: string) => Promise<Readonly<{ header?: Readonly<Record<string, unknown>> | null; body?: ArtifactBodyV1 | null }> | null>;
    decide: (args: Readonly<{ sessionId: string; artifactId: string; decision: 'approve' | 'reject' | 'cancel'; signal?: AbortSignal }>) => Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['executionRunHostActionApprovalReplay']> {
    return async ({ artifactId, decision, initialRead, context, signal }) => {
        const artifact = initialRead ? null : await deps.read(artifactId);
        const parsed = initialRead
            ? StoredExecutionRunHostActionApprovalRequestV1Schema.safeParse(initialRead.request)
            : null;
        const matched = artifact?.header && typeof artifact.body === 'string'
            ? approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body) : null;
        const request = initialRead ? parsed?.success ? parsed.data : null
            : matched?.family === 'execution_run_host_action' ? matched.request : null;
        if (!request) return null;
        if (context?.authority !== 'present_user') return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        signal?.throwIfAborted();
        const raw = await deps.decide({ artifactId, decision,
            sessionId: request.sessionId, ...(signal ? { signal } : {}) });
        const result = ExecutionRunHostActionApprovalSettlementV1Schema.safeParse(raw);
        if (result.success) return { ok: true, result: result.data };
        const refused = ActionExecuteFailureSchema.safeParse(raw);
        return refused.success ? refused.data : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
    };
}
