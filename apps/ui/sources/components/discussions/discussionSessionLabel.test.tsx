import { expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { discussionSessionLabel, discussionWaitingSessionName } from './discussionSessionLabel';

it('suppresses incidental Discussion Session identities while retaining the addressed Session', async () => {
    const previous = storage.getState();
    const session = createSessionFixture({ id: 'discussion-private', serverId: 'home-private', metadata: { name: 'Confidential launch', path: '/secret' } });
    storage.setState({ sessions: { [session.id]: session } });
    try {
        expect(discussionSessionLabel(session)).toBe('Confidential launch');
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'home-private': ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic('home-private', session.id, ['private']);
        setScreenSharingPrivacyActive(true);
        expect(discussionSessionLabel(session)).toBeNull();
        expect(discussionWaitingSessionName(session)).toBeNull();
        expect(storage.getState().sessions[session.id]).toBe(session);
        setScreenSharingPrivacyActive(false);
        expect(discussionSessionLabel(session)).toBe('Confidential launch');
    } finally { setScreenSharingPrivacyActive(false); storage.setState(previous); }
});
