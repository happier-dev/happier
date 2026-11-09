import { expect, it } from 'vitest';
import { resolveDetailNavigationItems } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { resolveDiscussionMobileSurfaces } from './discussionMobileSurfaces';

it('declares Chat once beside the three companions and projects phone surfaces from that same list', () => {
    const items = resolveDetailNavigationItems({ scope: 'discussion' });
    expect(items.map(item => item.id)).toEqual(['chat', 'discussionParticipants', 'discussionAgents', 'discussionDetails']);
    expect(items[0]?.navigation).toEqual({ kind: 'page', page: 'chat', desktop: 'tabs' });
    expect(items.slice(1).every(item => item.navigation.kind === 'companion')).toBe(true);
    expect(resolveDiscussionMobileSurfaces(items).map(entry => entry.surface)).toEqual(['participants', 'agents', 'details']);
    expect(items.every(item => item.phonePlacement === 'bar')).toBe(true);
});
