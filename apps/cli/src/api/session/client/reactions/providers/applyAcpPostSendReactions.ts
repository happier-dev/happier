import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';

import type {
    ACPMessageData,
    ACPProvider,
} from '../../../sessionMessageTypes';
import { applyAgentStatePublishedRequest } from '../../../agentStateRecords';
import {
    updateAgentStateBestEffort,
} from '../../../sessionWritesBestEffort';
import {
    resolveUsageObservationExternalKey,
} from '../../../outbound/shared';
import {
    publishTokenCountUsageObservation,
} from '../usagePublishing';
import type { PostSendReactionPort } from './postSendReactionPort';

type AcpPermissionRequest = Extract<ACPMessageData, { type: 'permission-request' }>;

function mirrorPublishedPermissionRequest(
    port: PostSendReactionPort,
    params: Readonly<{
        provider: ACPProvider;
        body: AcpPermissionRequest;
    }>,
): void {
    updateAgentStateBestEffort(
        port,
        (currentState) =>
            applyAgentStatePublishedRequest({
                state: currentState,
                requestId: params.body.permissionId,
                toolName: params.body.toolName,
                toolArguments: params.body.options ?? {},
                createdAtMs: Date.now(),
                kind: resolveAgentRequestKind(params.body.toolName),
                source: params.provider,
            }),
        '[API]',
        'mirror_acp_permission_request',
    );
}

export function applyAcpPostSendReactions(
    port: PostSendReactionPort,
    params: Readonly<{
        provider: ACPProvider;
        normalizedBody: ACPMessageData;
        localId: string;
    }>,
): void {
    if (params.normalizedBody.type === 'permission-request') {
        mirrorPublishedPermissionRequest(port, {
            provider: params.provider,
            body: params.normalizedBody,
        });
    }

    if (params.normalizedBody.type !== 'token_count') {
        return;
    }

    void publishTokenCountUsageObservation({
        sessionId: port.sessionId,
        publisher: port.usageObservationPublisher,
        provider: params.provider,
        body: params.normalizedBody,
        // The normalized token-count shape is shared by several native
        // transports. Its provider/source fields preserve the useful usage
        // observation without guessing at an Agent-owned runtime mode.
        backendMode: null,
        externalKey: resolveUsageObservationExternalKey({
            body: params.normalizedBody,
            fallbackLocalId: params.localId,
        }),
    });
}
