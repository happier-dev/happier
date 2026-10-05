import { describe, expect, it } from 'vitest';

import { resolveParticipantRoutingDescriptor, resolveParticipantRoutedSend } from './resolveParticipantRoutedSend';
import { buildReviewCommentsOutboundMessage } from '../reviewComments/buildReviewCommentsOutboundMessage';

describe('resolveParticipantRoutedSend', () => {
    it('carries exact review-comment context and attachments to the selected Run without overwriting the content envelope', () => {
        const comment = {
            id: 'comment-1', filePath: 'src/a.ts', source: 'diff' as const,
            anchor: { kind: 'diffLine' as const, startLine: 1, side: 'after' as const, oldLine: 1, newLine: 1 },
            snapshot: { selectedLines: ['+const value = 2;'], beforeContext: [], afterContext: [] },
            body: 'Explain this change', createdAt: 1,
        };
        const message = buildReviewCommentsOutboundMessage({ sessionId: 'session-1', drafts: [comment],
            additionalMessage: 'Why does this stop change the value?',
            metaOverrides: { happier: { kind: 'attachments.v1', payload: { attachments: [{ name: 'note.txt', path: '/repo/note.txt' }] } } } });
        const outbound = resolveParticipantRoutedSend({ ...message, recipient: { kind: 'execution_run', runId: 'writer' } });
        expect(outbound.recipient).toEqual({ kind: 'execution_run', runId: 'writer' });
        expect(outbound.text).toContain(comment.body);
        expect(outbound.displayText).toBe(message.displayText);
        expect(outbound.metaOverrides).toMatchObject({
            happier: { kind: 'review_comments.v1', payload: { comments: [expect.objectContaining({ id: comment.id })] } },
            happierAttachments: { kind: 'attachments.v1' },
        });
    });
    it('preserves an exact selected target when the local roster has no evidence', () => {
        const descriptor = resolveParticipantRoutingDescriptor({
            recipient: { kind: 'execution_run', runId: 'run_1' },
            targets: [],
        });

        expect(descriptor).toEqual({ type: 'session_message', recipient: { kind: 'execution_run', runId: 'run_1' } });
    });

    it('resolves execution run routing descriptors from live participant targets', () => {
        const descriptor = resolveParticipantRoutingDescriptor({
            recipient: { kind: 'execution_run', runId: 'run_1' },
            targets: [
                {
                    key: 'run-1',
                    displayLabel: 'Run 1',
                    recipient: { kind: 'execution_run', runId: 'run_1' },
                },
            ],
        });

        expect(descriptor).toEqual({
            type: 'session_message',
            recipient: { kind: 'execution_run', runId: 'run_1' },
        });
    });

    it('routes agent team recipients to a session message with participant_message.v1 meta', () => {
        const outbound = resolveParticipantRoutedSend({
            text: 'hello',
            recipient: { kind: 'agent_team_member', teamId: 'probe', memberId: 'alpha@probe' },
        });
        expect(outbound.type).toBe('session_message');
        expect((outbound as any).text).toBe('hello');
        expect((outbound as any).metaOverrides?.happier?.kind).toBe('participant_message.v1');
        expect((outbound as any).metaOverrides?.happier?.payload?.recipient?.kind).toBe('agent_team_member');
    });

    it('routes execution runs through the same Session submission with a normalized recipient', () => {
        const outbound = resolveParticipantRoutedSend({
            text: 'steer',
            recipient: { kind: 'execution_run', runId: 'run_1', label: 'Run one' },
        });
        expect(outbound).toMatchObject({
            type: 'session_message', text: 'steer',
            recipient: { kind: 'execution_run', runId: 'run_1' },
        });
        expect(outbound).not.toHaveProperty('delivery');
    });

    it('preserves the canonical requested action for a Run', () => {
        const outbound = resolveParticipantRoutedSend({
            text: 'interrupt',
            recipient: { kind: 'execution_run', runId: 'run_2' },
            requestedAction: { v: 1, kind: 'send_now' },
        });
        expect(outbound).toMatchObject({
            type: 'session_message', recipient: { kind: 'execution_run', runId: 'run_2' },
            requestedAction: { v: 1, kind: 'send_now' },
        });
    });
});
