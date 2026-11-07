import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

// The anchored menu's portal is the platform boundary; its items and selection stay the component's.
const menus = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: Record<string, unknown> & { trigger: (input: Record<string, unknown>) => React.ReactNode }) => {
    if (typeof props.testID === 'string') menus.set(props.testID, props);
    return <>{props.trigger({ open: false, toggle: vi.fn(), openMenu: vi.fn(), closeMenu: vi.fn(), selectedItem: null })}</>;
  },
}));

// Navigation and the Home feature bits are host boundaries; the row's menu logic stays real.
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));

import { DiscussionAgentsPanel, type DiscussionParticipantManagement } from './DiscussionParticipantsPopover';

const lifetime: ServerAccountScopeLifetime = {
  scope: { serverId: 'roster-home', accountId: 'viewer' },
  isCurrent: () => true,
  onRetire: () => ({ dispose: () => undefined }),
};

function itemIds(testID: string): readonly string[] {
  return ((menus.get(testID)?.items ?? []) as ReadonlyArray<{ id: string }>).map((item) => item.id);
}

describe('Discussion agent row menu (P2)', () => {
  const previous = storage.getState();
  afterEach(() => { menus.clear(); storage.setState(previous); });

  async function renderAgents(management: DiscussionParticipantManagement | null) {
    const session = createSessionFixture({ id: 'reviewer', serverId: 'roster-home', metadata: { name: 'Reviewer', path: '/repo', flavor: 'codex' } });
    storage.setState({ sessions: { [session.id]: session } });
    const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'thread', ownerAccountId: 'owner', access: management ? 'owner' : 'view', grants: [],
      participants: [{ participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'when_addressed', createdAt: 1 }] });
    return renderScreen(<DiscussionAgentsPanel accountLifetime={lifetime} serverId="roster-home" roster={roster}
      management={management} canManage={management !== null} />);
  }

  it('gives someone who does not manage the Discussion the row ⋯ with Mute and Open, and no policies or Remove', async () => {
    const screen = await renderAgents(null);
    try {
      expect(screen.findByTestId('discussion-agent-participant-0:more')).not.toBeNull();
      const ids = itemIds('discussion-agent-participant-0:menu');
      expect(ids).toEqual(['follow', 'mute', 'open']);
      expect(ids).not.toContain('remove');
      expect(ids).not.toContain('when_addressed');
    } finally { await screen.unmount(); }
  });

  it('keeps the manager’s policy pill, with Mute and Open between the policies and Remove', async () => {
    const management = { operation: { kind: 'idle' }, remove: vi.fn(), setPolicy: vi.fn(), inviteExecutable: vi.fn(), modelParticipants: [] } as unknown as DiscussionParticipantManagement;
    const screen = await renderAgents(management);
    try {
      expect(screen.findByTestId('discussion-agent-participant-0:more')).toBeNull();
      const ids = itemIds('discussion-agent-participant-0:menu');
      expect(ids[0]).toBe('when_addressed');
      expect(ids.indexOf('mute')).toBeGreaterThan(ids.indexOf('watches_and_speaks_up'));
      expect(ids.indexOf('mute')).toBeLessThan(ids.indexOf('open'));
      expect(ids[ids.length - 1]).toBe('remove');
    } finally { await screen.unmount(); }
  });
});
