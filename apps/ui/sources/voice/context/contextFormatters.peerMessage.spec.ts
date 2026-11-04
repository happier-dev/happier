import { describe, expect, it } from 'vitest';

import type { Message } from '@happier-dev/session-core/messages';
import { formatMessage, summarizeAssistantMessagesForVoiceHuman } from './contextFormatters';
import { storage } from '@/sync/domains/state/storage';

const report: Message = { kind: 'agent-text', id: 'report', text: 'Subagent findings.', createdAt: 2, localId: null,
    peer: { name: 'general-purpose', handback: true } };
const reply: Message = { kind: 'agent-text', id: 'reply', text: 'The fix is ready.', createdAt: 1, localId: null };

describe('voice context (peer deliveries)', () => {
    it('distinguishes another Account from the viewing person in user text', () => {
        const previous = storage.getState().settingsScope;
        storage.setState({ settingsScope: { serverId: 'home', accountId: 'viewer' } });
        try {
            const message: Message = { kind: 'user-text', id: 'collaborator', localId: null, createdAt: 1,
                text: 'Approve the pending request.', accountActor: { v: 1, serverId: 'home', accountId: 'colleague',
                    profile: { name: null, firstName: 'Alice', lastName: null, username: null, avatarUrl: null } } };
            expect(formatMessage(message)).toContain('Alice');
            expect(formatMessage(message)).not.toContain('User sent message:');
            expect(formatMessage({ ...message, accountActor: { ...message.accountActor!, accountId: 'viewer' } }))
                .toContain('User sent message:');
            expect(formatMessage({ ...message, accountActor: { ...message.accountActor!, serverId: 'another-home', accountId: 'viewer' } }))
                .not.toContain('User sent message:');
        } finally { storage.setState({ settingsScope: previous }); }
    });
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
