import { describe, expect, it } from 'vitest';

import {
    isConnectedServiceItemCollapsed,
    resolveConnectedServiceCollapseKey,
    setConnectedServiceItemCollapsed,
} from './resolveConnectedServiceCollapseKey';

// Variant defaults: accounts expanded (false), pool members collapsed (true).
const ACCOUNT_DEFAULT_COLLAPSED = false;
const MEMBER_DEFAULT_COLLAPSED = true;
const ACCOUNT = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    scope: { serverId: 'home', accountId: 'viewer' }, profileId: 'p1' };
const ACCOUNT_KEY = resolveConnectedServiceCollapseKey(ACCOUNT);
const MEMBER_KEY = resolveConnectedServiceCollapseKey({ ...ACCOUNT, groupId: 'g1' });

describe('resolveConnectedServiceCollapseKey', () => {
    it('qualifies device disclosure by Home, Account and connected contribution without punctuation collisions', () => {
        const first = { profileId: 'default',
            service: { pluginId: 'happier.agent.codex', localId: 'same' },
            scope: { serverId: 'home', accountId: 'viewer' } };
        const second = { ...first, service: { pluginId: 'happier.agent.claude', localId: 'same' } };
        expect(resolveConnectedServiceCollapseKey(first)).not.toBe(resolveConnectedServiceCollapseKey(second));
        expect(resolveConnectedServiceCollapseKey({ ...first, scope: { serverId: 'other-home', accountId: 'viewer' } }))
            .not.toBe(resolveConnectedServiceCollapseKey(first));
    });
    it('namespaces standalone accounts distinctly from pool members', () => {
        expect(
            resolveConnectedServiceCollapseKey(ACCOUNT),
        ).toBe('connectedServices:["home","viewer","happier.agent.claude","claude-subscription","account","p1"]');

        expect(
            resolveConnectedServiceCollapseKey({ ...ACCOUNT, groupId: 'g1' }),
        ).toBe('connectedServices:["home","viewer","happier.agent.claude","claude-subscription","pool","g1","p1"]');
    });

    it('treats nullish/empty groupId as a standalone account, not a pool member', () => {
        expect(resolveConnectedServiceCollapseKey({ ...ACCOUNT, groupId: null })).toBe(resolveConnectedServiceCollapseKey(ACCOUNT));
        expect(resolveConnectedServiceCollapseKey({ ...ACCOUNT, groupId: '' })).toBe(resolveConnectedServiceCollapseKey(ACCOUNT));
    });

    it('does not collide between the same account standalone vs as a pool member', () => {
        const accountKey = resolveConnectedServiceCollapseKey(ACCOUNT);
        const memberKey = resolveConnectedServiceCollapseKey({ ...ACCOUNT, groupId: 'g' });
        expect(accountKey).not.toBe(memberKey);
    });
    it('keeps exact punctuation-bearing identities distinct', () => {
        expect(resolveConnectedServiceCollapseKey({ ...ACCOUNT, profileId: 'a:b', groupId: 'c' }))
            .not.toBe(resolveConnectedServiceCollapseKey({ ...ACCOUNT, profileId: 'a%3Ab', groupId: 'c' }));
        expect(resolveConnectedServiceCollapseKey({ ...ACCOUNT, scope: { serverId: 'home:viewer', accountId: 'member' } }))
            .not.toBe(resolveConnectedServiceCollapseKey({ ...ACCOUNT, scope: { serverId: 'home', accountId: 'viewer:member' } }));
        expect(resolveConnectedServiceCollapseKey({ ...ACCOUNT, scope: { serverId: 'home', accountId: 'viewer2' } }))
            .not.toBe(resolveConnectedServiceCollapseKey(ACCOUNT));
    });
});

describe('isConnectedServiceItemCollapsed', () => {
    it('applies the per-variant default when the key is absent', () => {
        expect(isConnectedServiceItemCollapsed({}, ACCOUNT_KEY, ACCOUNT_DEFAULT_COLLAPSED)).toBe(false);
        expect(isConnectedServiceItemCollapsed({}, MEMBER_KEY, MEMBER_DEFAULT_COLLAPSED)).toBe(true);
        expect(isConnectedServiceItemCollapsed(null, ACCOUNT_KEY, ACCOUNT_DEFAULT_COLLAPSED)).toBe(false);
        expect(isConnectedServiceItemCollapsed(undefined, MEMBER_KEY, MEMBER_DEFAULT_COLLAPSED)).toBe(true);
    });

    it('honors an explicit stored deviation over the default', () => {
        expect(isConnectedServiceItemCollapsed({ [ACCOUNT_KEY]: true }, ACCOUNT_KEY, ACCOUNT_DEFAULT_COLLAPSED)).toBe(
            true,
        );
        expect(isConnectedServiceItemCollapsed({ [MEMBER_KEY]: false }, MEMBER_KEY, MEMBER_DEFAULT_COLLAPSED)).toBe(
            false,
        );
    });
});

describe('setConnectedServiceItemCollapsed (sparse map)', () => {
    it('persists only deviations from the variant default', () => {
        // Collapsing an account (default expanded) is a deviation → stored.
        const collapsedAccount = setConnectedServiceItemCollapsed({}, ACCOUNT_KEY, true, ACCOUNT_DEFAULT_COLLAPSED);
        expect(collapsedAccount).toEqual({ [ACCOUNT_KEY]: true });

        // Expanding a pool member (default collapsed) is a deviation → stored.
        const expandedMember = setConnectedServiceItemCollapsed({}, MEMBER_KEY, false, MEMBER_DEFAULT_COLLAPSED);
        expect(expandedMember).toEqual({ [MEMBER_KEY]: false });
    });

    it('removes the key when the value returns to the variant default', () => {
        const collapsed = setConnectedServiceItemCollapsed({}, ACCOUNT_KEY, true, ACCOUNT_DEFAULT_COLLAPSED);
        const reExpanded = setConnectedServiceItemCollapsed(collapsed, ACCOUNT_KEY, false, ACCOUNT_DEFAULT_COLLAPSED);
        expect(reExpanded).toEqual({});
    });

    it('does not mutate the input map', () => {
        const input = { [MEMBER_KEY]: false } as const;
        const next = setConnectedServiceItemCollapsed(input, ACCOUNT_KEY, true, ACCOUNT_DEFAULT_COLLAPSED);
        expect(input).toEqual({ [MEMBER_KEY]: false });
        expect(next).toEqual({ [MEMBER_KEY]: false, [ACCOUNT_KEY]: true });
    });
});
