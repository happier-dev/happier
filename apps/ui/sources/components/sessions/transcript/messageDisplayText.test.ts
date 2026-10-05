import { describe, expect, it } from 'vitest';
import type { AgentTextMessage, UserTextMessage } from '@happier-dev/session-core/messages';
import { resolveTranscriptMessageDisplayText } from './messageDisplayText';

const agent = (overrides: Partial<AgentTextMessage> = {}): AgentTextMessage => ({
    kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'visible', ...overrides,
});
const user = (overrides: Partial<UserTextMessage> = {}): UserTextMessage => ({
    kind: 'user-text', id: 'u', localId: null, createdAt: 1, text: 'visible', ...overrides,
});

describe('resolveTranscriptMessageDisplayText', () => {
    it('prepares the exact source input for Markdown rendering rather than hidden message scaffolding', () => {
        expect(resolveTranscriptMessageDisplayText(user({ displayText: '**display override**' })).text).toBe('**display override**');
        expect(resolveTranscriptMessageDisplayText(user({
            text: '**visible**\n\nAttachments:\n[attachments]\nprivate suffix\n[/attachments]',
            meta: { happier: { kind: 'attachments.v1', payload: { attachments: [{ name: 'note', path: '/note', sizeBytes: 1 }] } } },
        })).text).toBe('**visible**');
        expect(resolveTranscriptMessageDisplayText(agent({ isThinking: true, text: '*Thinking...*\n\n*visible 😀*' })).text).toBe('visible 😀');
        expect(resolveTranscriptMessageDisplayText(user({
            text: 'Context updates since your last voice turn:\nprivate context\n\nUser said:\n**visible**',
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
        }))).toMatchObject({ text: '**visible**', isVoiceAgentTurn: true });
    });

    it('uses canonical visibility and developer diagnostics for thinking and unsupported content', () => {
        expect(resolveTranscriptMessageDisplayText(agent({ isThinking: true }), { thinkingDisplayMode: 'hidden' }).text).toBeNull();
        const unsupported = agent({ text: '  diagnostic payload  ', meta: { happierUnsupportedContentV1: 'unsupported-agent-output' } });
        expect(resolveTranscriptMessageDisplayText(unsupported).text).toBeNull();
        expect(resolveTranscriptMessageDisplayText(unsupported, { debugInformationEnabled: true })).toMatchObject({
            text: 'diagnostic payload', unsupportedContentText: 'diagnostic payload',
        });
    });
});
