import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { projectTranscriptFindText } from './transcriptFindText';

describe('projectTranscriptFindText', () => {
    it('uses the same Markdown display input for user overrides and agent messages', () => {
        const user: Message = { kind: 'user-text', id: 'u', localId: null, createdAt: 1, text: 'private source', displayText: ' visible 😀 ' };
        const agent: Message = { kind: 'agent-text', id: 'a', localId: null, createdAt: 2, text: '**visible**' };
        expect(projectTranscriptFindText(user)).toEqual([{
            id: 'text', kind: 'markdown', text: 'visible 😀', sourceText: ' visible 😀 ',
            sourceOffsets: Array.from({ length: 10 }, (_, index) => index + 1),
            sourceEnds: Array.from({ length: 10 }, (_, index) => index + 2),
        }]);
        expect(projectTranscriptFindText(agent)[0]).toMatchObject({ id: 'text', kind: 'markdown', text: 'visible' });
    });

    it('projects normalized renderer inputs rather than hidden attachment, voice, or thinking scaffolding', () => {
        const user: Message = {
            kind: 'user-text', id: 'u', localId: null, createdAt: 1,
            text: '**visible**\n\nAttachments:\n[attachments]\nsecret suffix\n[/attachments]',
            meta: { happier: { kind: 'attachments.v1', payload: { attachments: [{ name: 'note', path: '/note', sizeBytes: 1 }] } } },
        };
        const thinking: Message = {
            kind: 'agent-text', id: 'a', localId: null, createdAt: 2,
            isThinking: true, text: '*Thinking...*\n\n*visible 😀*',
        };
        const voice: Message = {
            kind: 'user-text', id: 'v', localId: null, createdAt: 3,
            text: 'Context updates since your last voice turn:\nsecret scaffolding\n\nUser said:\n**visible**',
            meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 3, role: 'user', voiceAgentId: 'mid', ts: 100 } } },
        };
        expect(projectTranscriptFindText(user)[0]).toMatchObject({ sourceText: '**visible**', text: 'visible' });
        expect(projectTranscriptFindText(thinking)[0]).toMatchObject({
            sourceText: 'visible 😀', text: 'visible 😀', sourceOffsets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        });
        expect(projectTranscriptFindText(voice)[0]).toMatchObject({ sourceText: '**visible**', text: 'visible' });
    });

    it('excludes hidden thinking and unsupported agent rows but preserves developer diagnostics', () => {
        const thinking: Message = { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'private thought', isThinking: true };
        const unsupported: Message = {
            kind: 'agent-text', id: 'b', localId: null, createdAt: 2, text: '  diagnostic payload  ',
            meta: { happierUnsupportedContentV1: 'unsupported-agent-output' },
        };
        expect(projectTranscriptFindText(thinking, { thinkingDisplayMode: 'hidden' })).toEqual([]);
        expect(projectTranscriptFindText(unsupported)).toEqual([]);
        expect(projectTranscriptFindText(unsupported, { debugInformationEnabled: true })[0]).toMatchObject({
            sourceText: 'diagnostic payload', text: 'diagnostic payload',
        });
    });

    it('indexes replacing structured fallback copy rather than the hidden raw payload body', () => {
        const message: Message = {
            kind: 'agent-text', id: 's', localId: null, createdAt: 1, text: 'private raw payload',
            meta: { happier: { kind: 'unknown-plugin-card.v1', payload: { privateValue: 'secret' } } },
        };
        const blocks = projectTranscriptFindText(message);
        expect(blocks.some((block) => block.id.startsWith('structured-unavailable-') && block.text.length > 0)).toBe(true);
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('private raw payload');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('secret');
    });

    it('projects real tool title and revealable body owners while excluding invisible payload metadata', () => {
        const message: Message = {
            kind: 'tool-call', id: 'tool-row', localId: null, createdAt: 1, children: [],
            tool: {
                id: 'tool-id', name: 'Bash', state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2,
                description: null, input: { command: 'printf visible', privateToken: 'secret-input' },
                result: { stdout: 'visible 😀 result', stderr: '', privateToken: 'secret-result' },
            },
        };
        const blocks = projectTranscriptFindText(message);
        expect(blocks.some((block) => block.id === 'tool-title' && block.kind === 'toolTitle' && block.text.length > 0)).toBe(true);
        expect(blocks.find((block) => block.id === 'tool-stdout')).toMatchObject({ text: 'visible 😀 result', kind: 'toolBody' });
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('secret-input');
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('secret-result');
    });

    it('includes the tool structured card and omits chrome hidden by the canonical activity-feed presentation', () => {
        const message: Message = {
            kind: 'tool-call', id: 's', localId: null, createdAt: 1, children: [],
            meta: { happier: { kind: 'unknown-plugin-card.v1', payload: {} } },
            tool: {
                id: 'tool', name: 'Unknown', state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2,
                description: null, input: {}, result: 'private hidden tool body',
            },
        };
        const blocks = projectTranscriptFindText(message, { toolViewTimelineChromeMode: 'activity_feed' });
        expect(blocks.some((block) => block.id.startsWith('structured-unavailable-'))).toBe(true);
        expect(blocks.some((block) => block.id === 'tool-title')).toBe(false);
        expect(blocks.map((block) => block.text).join('\n')).not.toContain('private hidden tool body');
    });
});
