import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { JsonlFollower } from '@/agent/localControl/jsonlFollower';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import { mapCodexRolloutEventToActions } from './rolloutMapper';

export class CodexRolloutMirror {
    private follower: JsonlFollower | null = null;
    private readonly streamedTranscriptWriter: StreamedTranscriptWriter;

    constructor(
        private readonly opts: {
            filePath: string;
            session: ApiSessionClient;
            debug: boolean;
            onCodexSessionId: (id: string) => void | Promise<void>;
        },
    ) {
        this.streamedTranscriptWriter = createStreamedTranscriptWriter({
            provider: 'codex',
            session: opts.session,
            checkpointIntervalMs: 0,
            checkpointMinChars: 1,
        });
    }

    async start(): Promise<void> {
        if (this.follower) return;
        const follower = new JsonlFollower({
            filePath: this.opts.filePath,
            pollIntervalMs: 250,
            startAtEnd: false,
            onJson: (value) => this.onJson(value),
        });
        this.follower = follower;
        await follower.start();
        if (this.follower !== follower) {
            await follower.stop();
        }
    }

    async stop(): Promise<void> {
        const follower = this.follower;
        this.follower = null;
        await follower?.stop();
        await this.streamedTranscriptWriter.flushAll({ reason: 'turn-end' });
    }

    private async onJson(value: unknown): Promise<void> {
        const actions = mapCodexRolloutEventToActions(value, { debug: this.opts.debug });
        for (const action of actions) {
            if (action.type === 'codex-session-id') {
                await this.opts.onCodexSessionId(action.id);
                continue;
            }
            if (action.type === 'user-text') {
                await this.streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' });
                this.opts.session.sendUserTextMessage(action.text);
                continue;
            }
            if (action.type === 'assistant-text') {
                this.streamedTranscriptWriter.appendAssistantDelta(action.text);
                continue;
            }
            if (action.type === 'tool-call') {
                await this.streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' });
                this.opts.session.sendCodexMessage({
                    type: 'tool-call',
                    callId: action.callId,
                    name: action.name,
                    input: action.input,
                    id: randomUUID(),
                });
                continue;
            }
            if (action.type === 'tool-result') {
                this.opts.session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: action.callId,
                    output: action.output,
                    id: randomUUID(),
                });
                continue;
            }
            if (action.type === 'debug') {
                this.opts.session.sendSessionEvent({
                    type: 'message',
                    message: `[codex-local] ${action.message}`,
                });
                continue;
            }
        }
    }
}
