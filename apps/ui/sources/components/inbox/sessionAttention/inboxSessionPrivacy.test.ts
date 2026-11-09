import { afterEach, describe, expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { readInboxSessionTitle } from './inboxSessionPrivacy';
import { readApprovalSessionName } from '@/components/approvals/useApprovalSessionReading';
import { discussionSessionLabel, discussionWaitingSessionName } from '@/components/discussions/discussionSessionLabel';

const initialState = storage.getState();
afterEach(() => { setScreenSharingPrivacyActive(false); storage.setState(initialState, true); });

describe('incidental Session identity during recording privacy', () => {
    it('masks Inbox, approval and Discussion labels while retaining the requesting Session', () => {
        const session = createSessionListRenderableSessionFixture({ id: 'private', serverId: 'home-private',
            metadata: { name: 'Confidential release', path: '/private/release', host: 'private-host' } });
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'home-private': ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic('home-private', session.id, ['private']);
        const title = () => readInboxSessionTitle(session, 'home-private');
        expect(title()).toBe('Confidential release');
        setScreenSharingPrivacyActive(true);
        expect(title()).not.toContain('Confidential release');
        expect(readApprovalSessionName(session, 'home-private')).toBeNull();
        expect(discussionSessionLabel(session) ?? '').not.toContain('Confidential release');
        expect(discussionWaitingSessionName(session) ?? '').not.toContain('Confidential release');
        setScreenSharingPrivacyActive(false);
        expect(title()).toBe('Confidential release');
    });
});
