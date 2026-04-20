import type { Metadata } from '../../../types';
import type {
    ACPMessageData,
    ACPProvider,
} from '../../sessionMessageTypes';
import {
    prepareAcpSessionOutboundMessage,
} from './acp';
import {
    buildClaudeSessionOutboundMessage,
} from './claude';
import {
    buildCodexSessionOutboundMessage,
} from './codex';

export type TranscriptDispatchToolMaps = Readonly<{
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
    toolCallInputByProviderAndId: Map<string, unknown>;
}>;

export function prepareClaudeTranscriptDispatch(params: Readonly<{
    body: import('@/backends/claude/contracts/rawJsonLines').RawJSONLines;
    meta?: Record<string, unknown>;
}>) {
    return buildClaudeSessionOutboundMessage(params);
}

export function prepareCodexTranscriptDispatch(params: Readonly<{
    body: unknown;
    metadata: Metadata | null;
    toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
    debug: (message: string, data?: unknown) => void;
}>) {
    return buildCodexSessionOutboundMessage(params);
}

export function prepareAcpTranscriptDispatch(params: Readonly<{
    provider: ACPProvider;
    body: ACPMessageData;
    meta?: Record<string, unknown>;
    localId?: string;
}> & TranscriptDispatchToolMaps) {
    return prepareAcpSessionOutboundMessage(params);
}
