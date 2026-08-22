import {
    SessionAgentTransitionBriefPreviewRequestV1Schema,
    SessionAgentTransitionBriefPreviewV1Schema,
    SessionAgentTransitionRequestV1Schema,
    SessionAgentTransitionResultV1Schema,
    SessionContinuationInspectionRequestV1Schema,
    SessionContinuationInspectionV1Schema,
    rejectUndispatchedSessionAgentTransition,
    type SessionAgentTransitionBriefPreviewV1,
    type SessionAgentTransitionResultV1,
    type SessionContinuationInspectionV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { runSessionAgentTransition } from '@/session/agentTransition/sessionAgentTransitionCoordinator';
import { previewSessionAgentTransitionBrief } from '@/session/agentTransition/previewSessionAgentTransitionBrief';
import { inspectSessionContinuation } from '@/session/agentTransition/sessionContinuationInspection';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';

/**
 * The three machine-scoped continuation operations.
 *
 * All are thin: request validation in, the canonical owner, zod-validated
 * result out. No transition state, retry loop, or recovery command lives here.
 */

export type SessionAgentTransitionRpcRegistrationOptions = Readonly<{
    readCredentials: () => Promise<StoredCredentials | null>;
    machineAdmissionTransport?: Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport'];
}>;

/**
 * Both transition rejections this handler can raise happen BEFORE the
 * coordinator is dispatched — a request that failed schema validation, or a
 * process holding no credentials — so nothing addressed the Session and there
 * is no `localId` to correlate. They are built through the single arm owner
 * (`rejectUndispatchedSessionAgentTransition`) rather than as literals, so the
 * handler cannot drift into naming an arm the coordinator's effect stages
 * forbid.
 */
const CREDENTIALS_UNAVAILABLE_TRANSITION: SessionAgentTransitionResultV1 =
    rejectUndispatchedSessionAgentTransition('forbidden');

const CREDENTIALS_UNAVAILABLE_INSPECTION: SessionContinuationInspectionV1 = {
    type: 'unavailable',
    reason: 'operation_unavailable',
};

/**
 * A process with no credentials cannot read the Session at all, which is the
 * same standing as a Session this machine cannot address. It is deliberately
 * NOT `empty`: reporting "nothing was carried over" because we could not look
 * is the one answer this surface must never give.
 */
const CREDENTIALS_UNAVAILABLE_BRIEF_PREVIEW: SessionAgentTransitionBriefPreviewV1 = {
    type: 'unavailable',
    reason: 'unsupported_session',
};

export function registerSessionAgentTransitionRpcHandlers(
    rpc: RpcHandlerRegistrar,
    options: SessionAgentTransitionRpcRegistrationOptions,
): void {
    rpc.registerHandler(RPC_METHODS.SESSION_AGENT_TRANSITION, async (raw: unknown) => {
        const parsed = SessionAgentTransitionRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return SessionAgentTransitionResultV1Schema.parse(
                rejectUndispatchedSessionAgentTransition('unsupported_operation'),
            );
        }
        const credentials = await options.readCredentials();
        if (!credentials) {
            return SessionAgentTransitionResultV1Schema.parse(CREDENTIALS_UNAVAILABLE_TRANSITION);
        }
        const result = await runSessionAgentTransition({
            credentials,
            request: parsed.data,
            ...(options.machineAdmissionTransport
                ? { machineAdmissionTransport: options.machineAdmissionTransport }
                : {}),
        });
        return SessionAgentTransitionResultV1Schema.parse(result);
    });

    rpc.registerHandler(RPC_METHODS.SESSION_CONTINUATION_INSPECT, async (raw: unknown) => {
        const parsed = SessionContinuationInspectionRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return SessionContinuationInspectionV1Schema.parse({
                type: 'unavailable',
                reason: 'unsupported_session',
            });
        }
        const credentials = await options.readCredentials();
        if (!credentials) {
            return SessionContinuationInspectionV1Schema.parse(CREDENTIALS_UNAVAILABLE_INSPECTION);
        }
        const inspection = await inspectSessionContinuation({
            credentials,
            request: parsed.data,
        });
        return SessionContinuationInspectionV1Schema.parse(inspection);
    });

    rpc.registerHandler(RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW, async (raw: unknown) => {
        const parsed = SessionAgentTransitionBriefPreviewRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return SessionAgentTransitionBriefPreviewV1Schema.parse({
                type: 'unavailable',
                reason: 'unsupported_session',
            });
        }
        const credentials = await options.readCredentials();
        if (!credentials) {
            return SessionAgentTransitionBriefPreviewV1Schema.parse(CREDENTIALS_UNAVAILABLE_BRIEF_PREVIEW);
        }
        const preview = await previewSessionAgentTransitionBrief({
            credentials,
            request: parsed.data,
        });
        return SessionAgentTransitionBriefPreviewV1Schema.parse(preview);
    });
}
