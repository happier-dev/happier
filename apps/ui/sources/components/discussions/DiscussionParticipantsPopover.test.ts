import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';

import { DiscussionRosterFaces, resolveDiscussionOwnerTransferAvatar } from './DiscussionParticipantsPopover';

describe('resolveDiscussionOwnerTransferAvatar', () => {
  it('does not retain the Account-specific face for a former transfer candidate', () => {
    expect(resolveDiscussionOwnerTransferAvatar({
      v: 1,
      serverId: 'server-1',
      accountId: 'former-account',
      accessibility: 'former',
      profile: {
        name: 'Retained Name',
        username: 'retained',
        firstName: 'Retained',
        lastName: 'Name',
        avatarUrl: 'https://example.test/retained.png',
      },
    }, 'former-account', 'viewer')).toEqual({
      id: 'former-member',
      imageUrl: null,
    });
  });
});


it('makes the private participant Agent mark neutral in an open Discussion roster', async () => {
  const previous = storage.getState();
  const session = createSessionFixture({ id: 'private-agent', serverId: 'roster-home', metadata: { name: 'Private reviewer', path: '/secret', flavor: 'codex' } });
  storage.setState({ sessions: { [session.id]: session } });
  const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'thread', ownerAccountId: 'viewer', access: 'owner', grants: [],
    participants: [{ participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed', createdAt: 1 }] });
  const screen = await renderScreen(React.createElement(DiscussionRosterFaces, { roster, serverId: 'roster-home', accountActors: new Map(), viewerAccountId: 'viewer', accessibilityLabel: 'People' }));
  try {
    expect(screen.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(1);
    await act(async () => {
      storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'roster-home': ['private'] } });
      storage.getState().setSessionTagAssignmentsOptimistic('roster-home', session.id, ['private']);
      setScreenSharingPrivacyActive(true);
    });
    expect(screen.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(0);
    expect(storage.getState().sessions[session.id]).toBe(session);
    await act(async () => setScreenSharingPrivacyActive(false));
    expect(screen.findAllByType(SessionAgentCatalogIdentityIcon)).toHaveLength(1);
  } finally { await screen.unmount(); setScreenSharingPrivacyActive(false); storage.setState(previous); }
});
