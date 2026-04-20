import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchProviderTranscriptMessage } from './providerDispatch';
import type { SessionClientTranscriptSendPort } from './sendMessages';
import type { PostSendReactionPort } from '../reactions/providers/postSendReactionPort';

const { claudeSendSpy, codexSendSpy } = vi.hoisted(() => ({
    claudeSendSpy: vi.fn(),
    codexSendSpy: vi.fn(),
}));

vi.mock('@/backends/claude/session/sendMessage', () => ({
    sendClaudeSessionClientMessage: claudeSendSpy,
}));

vi.mock('@/backends/codex/session/sendMessage', () => ({
    sendCodexSessionClientMessage: codexSendSpy,
}));

function createPort(): SessionClientTranscriptSendPort {
    return {
        sessionId: 'session-1',
        socket: {
            connected: true,
            emit: vi.fn(),
        },
        outboundShapeLogger: {
            log: vi.fn(),
        },
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        getMetadataSnapshot: () => null,
        buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
        commitSessionMessageBestEffort: vi.fn(),
        logSendWhileDisconnected: vi.fn(),
        markAgentQueueEchoSuppressedLocalId: vi.fn(),
        toolCallCanonicalNameByProviderAndId: new Map(),
        permissionToolCallRawInputByProviderAndId: new Map(),
        toolCallInputByProviderAndId: new Map(),
    };
}

function createOpts(): Readonly<{
    sessionId: string;
    postSendReactionPort: PostSendReactionPort;
}> {
    return {
        sessionId: 'session-1',
        postSendReactionPort: {
            sessionId: 'session-1',
            updateAgentState: vi.fn(async (updater) => updater({} as never)),
            updateMetadata: vi.fn(async (updater) => updater({} as never)),
            getMetadataSnapshot: () => null,
            usageObservationPublisher: {
                publish: vi.fn(async () => undefined),
            },
        },
    };
}

describe('providerDispatch', () => {
    beforeEach(() => {
        claudeSendSpy.mockReset();
        codexSendSpy.mockReset();
    });

    it('routes claude transcript messages through the neutral dispatch seam', () => {
        const port = createPort();
        const opts = createOpts();
        const body = {
            type: 'assistant',
            uuid: 'claude-1',
            message: {
                content: [{ type: 'text', text: 'hello' }],
            },
        } as const;

        dispatchProviderTranscriptMessage(port, { provider: 'claude', body, meta: { importedFrom: 'lane-p3' } }, opts);

        expect(claudeSendSpy).toHaveBeenCalledWith(port, body, { importedFrom: 'lane-p3' }, opts);
        expect(codexSendSpy).not.toHaveBeenCalled();
    });

    it('routes codex transcript messages through the neutral dispatch seam', () => {
        const port = createPort();
        const opts = createOpts();
        const body = { type: 'message', message: 'hello from codex' };

        dispatchProviderTranscriptMessage(port, { provider: 'codex', body }, opts);

        expect(codexSendSpy).toHaveBeenCalledWith(port, body, opts);
        expect(claudeSendSpy).not.toHaveBeenCalled();
    });
});
