import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { formatMessage, summarizeAssistantMessagesForVoiceHuman } from './contextFormatters';

const report: Message = { kind: 'agent-text', id: 'report', text: 'Subagent findings.', createdAt: 2, localId: null,
    peer: { name: 'general-purpose', handback: true } };
const reply: Message = { kind: 'agent-text', id: 'reply', text: 'The fix is ready.', createdAt: 1, localId: null };

describe('voice context (peer deliveries)', () => {
    it('attributes a delivered subagent report to its sender rather than the coding assistant', () => {
        const out = formatMessage(report);
        expect(out).toContain('general-purpose');
        expect(out).toContain('Subagent findings.');
        expect(out).not.toContain('Coding assistant:');
    });

    it('never summarizes a delivered report as the latest assistant reply', () => {
        expect(summarizeAssistantMessagesForVoiceHuman([reply, report])).toBe('The fix is ready.');
    });
});
