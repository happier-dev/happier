import { sendClaudeSessionClientMessage } from '@/backends/claude/session/sendMessage';
import { sendCodexSessionClientMessage } from '@/backends/codex/session/sendMessage';
import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';
import type { PostSendReactionPort } from '../reactions/providers/postSendReactionPort';
import type { SessionClientTranscriptSendPort } from './sendMessages';

export type ProviderTranscriptDispatchRequest =
    | Readonly<{
        provider: 'claude';
        body: RawJSONLines;
        meta?: Record<string, unknown>;
    }>
    | Readonly<{
        provider: 'codex';
        body: unknown;
    }>;

export type ProviderTranscriptDispatchOpts = Readonly<{
    sessionId: string;
    postSendReactionPort: PostSendReactionPort;
}>;

export function dispatchProviderTranscriptMessage(
    port: SessionClientTranscriptSendPort,
    request: ProviderTranscriptDispatchRequest,
    opts: ProviderTranscriptDispatchOpts,
): void {
    switch (request.provider) {
        case 'claude':
            sendClaudeSessionClientMessage(port, request.body, request.meta, opts);
            return;
        case 'codex':
            sendCodexSessionClientMessage(port, request.body, opts);
            return;
    }
}
