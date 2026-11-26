import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';
import { appendVoiceTargetSessionSwitchNote } from './appendVoiceTargetSessionSwitchNote';

const conversationSessionId = 'switch-note-carrier';
const activeServerId = getActiveServerSnapshot().serverId;
const previousTargetSessionAddress = { serverId: activeServerId, sessionId: 's1' };
const targetSessionAddress = { serverId: activeServerId, sessionId: 's2' };

function publishPrivacy(shareSessionSummary: boolean, shareFilePaths = true) {
    storage.setState({ settings: settingsParse({ voice: { privacy: { shareSessionSummary, shareFilePaths } } }) });
}
function publishSessions(summaryA: string, summaryB: string) {
    storage.setState({ sessions: {
        s1: createSessionFixture({ id: 's1', serverId: activeServerId,
            metadata: { ...fixtureMetadata, path: '', summary: { text: summaryA, updatedAt: 1 } } }),
        s2: createSessionFixture({ id: 's2', serverId: activeServerId,
            metadata: { ...fixtureMetadata, path: '', summary: { text: summaryB, updatedAt: 1 } } }),
    } });
}
function readNote() {
    const entries = selectVoiceTranscriptEntriesForConversationSession(storage.getState(), conversationSessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('note');
    return entries[0]?.text;
}

describe('appendVoiceTargetSessionSwitchNote', () => {
    beforeEach(() => {
        publishPrivacy(true);
        publishSessions('Private summary A', 'Private summary B');
        storage.setState({ sessionMessages: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {} });
    });
    it('projects a generic note when summary sharing is disabled', () => {
        publishPrivacy(false);
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress });
        expect(readNote()).toBe('Now talking to another session');
        expect(readNote()).not.toContain('Private summary');
    });
    it('projects one short row naming only the new target', () => {
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress });
        expect(readNote()).not.toContain('Private summary A');
    });
    it('projects shared session summaries through the canonical note reader', () => {
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress });
        expect(readNote()).toBe('Now talking to Private summary B');
    });
    it('redacts paths in summary labels before projecting the note', () => {
        publishPrivacy(true, false);
        publishSessions('Editing /Users/alice/SecretRepo/src/a.ts', 'Reviewing /Users/alice/SecretRepo/src/b.ts');
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress });
        expect(readNote()).toBe('Now talking to Reviewing <path_redacted>');
    });
    it('does not disclose lookup names when summary sharing is disabled', () => {
        publishPrivacy(false);
        storage.setState({ sessions: {}, sessionListRowsByServerId: { [activeServerId]: {
            s1: createSessionFixture({ id: 's1', updatedAt: 1, metadata: { ...fixtureMetadata,
                name: 'Voice Target Alpha', summaryText: 'Private summary A', path: '/tmp/alpha' } }),
            s2: createSessionFixture({ id: 's2', updatedAt: 2, metadata: { ...fixtureMetadata,
                name: 'Voice Tracked Beta', summaryText: 'Private summary B', path: '/tmp/beta' } }),
        } }, ordinarySessionListMembershipByServerId: { [activeServerId]: ['s1', 's2'] },
        sessionListIndexByServerId: { [activeServerId]: [
            { type: 'session', sessionId: 's1', serverId: activeServerId, serverName: 'Active' },
            { type: 'session', sessionId: 's2', serverId: activeServerId, serverName: 'Active' },
        ] } });
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress });
        expect(readNote()).toBe('Now talking to another session');
    });
    it('says no session is in focus when the target is cleared', () => {
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress: null });
        expect(readNote()).toBe('Not talking to a session');
    });
    it('treats raw session-id labels as unresolved', () => {
        publishPrivacy(false);
        storage.setState({ sessions: {
            s1: createSessionFixture({ id: 's1', serverId: activeServerId,
                metadata: { ...fixtureMetadata, path: '', name: 's1' } }),
            s2: createSessionFixture({ id: 's2', serverId: activeServerId,
                metadata: { ...fixtureMetadata, path: '', name: 's2' } }),
        } });
        appendVoiceTargetSessionSwitchNote({ conversationSessionId, previousTargetSessionAddress, targetSessionAddress });
        expect(readNote()).toBe('Now talking to another session');
    });
});
