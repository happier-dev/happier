import { randomUUID } from 'node:crypto';

import { buildAcpAgentMessageEnvelope } from '../../acpMessageEnvelope';
import type {
    ACPMessageData,
    ACPProvider,
} from '../../sessionMessageTypes';
import { normalizeAcpSessionMessageBody } from '../../sessionOutboundMessageNormalization';
import { readSidechainId } from '../shared';

export function prepareAcpSessionOutboundMessage(params: Readonly<{
    provider: ACPProvider;
    body: ACPMessageData;
    meta?: Record<string, unknown>;
    localId?: string;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
}>): Readonly<{
    normalizedBody: ACPMessageData;
    content: ReturnType<typeof buildAcpAgentMessageEnvelope>;
    localId: string;
    sidechainId: string | null;
}> {
    const normalizedBody = normalizeAcpSessionMessageBody({
        provider: params.provider,
        body: params.body,
        toolCallCanonicalNameByProviderAndId: params.toolCallCanonicalNameByProviderAndId,
        permissionToolCallRawInputByProviderAndId: params.permissionToolCallRawInputByProviderAndId,
        toolCallInputByProviderAndId: params.toolCallInputByProviderAndId,
    });
    const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();
    const sidechainId = readSidechainId(normalizedBody.sidechainId);
    const content = buildAcpAgentMessageEnvelope({
        provider: params.provider,
        body: normalizedBody,
        meta: params.meta,
    });

    return {
        normalizedBody,
        content,
        localId,
        sidechainId,
    };
}
