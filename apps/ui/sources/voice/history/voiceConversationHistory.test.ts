import { describe, expect, it } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { readVoiceConversationHistory } from './voiceConversationHistory';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

describe('Voice conversation History projection', () => {
    it('keeps a newer compact title and blocked-input fact ahead of an older opened Session', () => {
        const serverId = 'voice-history-home';
        const previous = createSessionFixture({ id: 'retained-voice', serverId, metadataVersion: 1,
            pendingCount: 0, pendingBlockedCount: 0,
            metadata: { ...createSessionFixture().metadata!, name: 'Earlier title',
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) },
        });
        const current = buildSessionListRenderableFromSession({ ...previous, metadataVersion: 2,
            pendingCount: 1, pendingBlockedCount: 1, metadata: { ...previous.metadata!, name: 'Current title' } });
        const history = readVoiceConversationHistory({ sessions: { [previous.id]: previous },
            sessionListRowsByServerId: { [serverId]: { [current.id]: current } } });
        expect(history.conversations).toMatchObject([{ title: 'Current title', hasBlockedInputs: true, canContinue: null }]);
    });
    it('keeps recipient conversations out of the person\'s own History', () => {
        const session = createSessionFixture({ id: 'shared-voice', serverId: 'voice-history-home',
            access: createSessionAccessFixture('admin'),
            metadata: { ...createSessionFixture().metadata!,
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) },
        });
        const row = buildSessionListRenderableFromSession(session);
        for (const state of [
            { sessions: { [session.id]: session }, sessionListRowsByServerId: {} },
            { sessions: {}, sessionListRowsByServerId: { [session.serverId!]: { [row.id]: row } } },
        ]) expect(readVoiceConversationHistory(state).conversations).toEqual([]);
    });
    it('uses ordinary Session meaningful activity rather than a later metadata write to order conversations', () => {
        const serverId = 'voice-history-home';
        const conversation = (id: string, updatedAt: number, meaningfulActivityAt: number) => createSessionFixture({
            id, serverId, updatedAt, meaningfulActivityAt,
            metadata: { ...createSessionFixture().metadata!,
                ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }), name: id },
        });
        const history = readVoiceConversationHistory({ sessions: {
            renamed: conversation('renamed', 10_000, 100),
            recent: conversation('recent', 200, 200),
        }, sessionListRowsByServerId: {} });

        expect(history.conversations.map(row => ({ id: row.address.sessionId, lastActivityAt: row.lastActivityAt })))
            .toEqual([{ id: 'recent', lastActivityAt: 200 }, { id: 'renamed', lastActivityAt: 100 }]);
    });
});
