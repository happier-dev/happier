import { describe, expect, it } from 'vitest';

import { ScopeActionInputSchemas } from '../../actions/scopeActionFamily.js';
import { matchSessionBotFilterV1, normalizeSessionListFilterV1, SessionListFilterV1Schema } from './sessionListFilterV1.js';

describe('SessionListFilterV1', () => {
    it('matches Bot identity only from authorized canonical metadata and distinguishes unavailable metadata', () => {
        expect(matchSessionBotFilterV1({ bot: { kind: 'bot', future: true } }, 'bot')).toBe('match');
        expect(matchSessionBotFilterV1({ title: 'Bot', tag: 'bot', pinned: true }, 'bot')).toBe('miss');
        expect(matchSessionBotFilterV1({}, 'ordinary')).toBe('match');
        for (const bot of [{ kind: 'ordinary' }, null]) {
            expect(matchSessionBotFilterV1({ bot }, 'ordinary')).toBe('unavailable');
            expect(matchSessionBotFilterV1({ bot }, 'bot')).toBe('unavailable');
        }
        expect(matchSessionBotFilterV1({ bot: { kind: 'bot' } }, 'ordinary')).toBe('miss');
        expect(matchSessionBotFilterV1(null, 'ordinary')).toBe('unavailable');
        expect(matchSessionBotFilterV1(undefined, 'bot')).toBe('unavailable');
        expect(matchSessionBotFilterV1(null)).toBe('match');
    });
    it('retains an optional Bot facet without changing an unset selection', () => {
        expect(normalizeSessionListFilterV1()).not.toHaveProperty('bot');
        for (const bot of ['bot', 'ordinary'] as const) {
            expect(SessionListFilterV1Schema.parse({ ...normalizeSessionListFilterV1(), bot }).bot).toBe(bot);
            expect(ScopeActionInputSchemas['session.list.view.set'].parse({ filters: { bot } }).filters).toEqual({ bot });
        }
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), bot: 'pinned' }).success).toBe(false);
    });
    it('defaults to sessions and runs you started', () => {
        expect(normalizeSessionListFilterV1()).toMatchObject({ show: 'both', startedBy: ['you'] });
    });

    it('normalizes started-by selections without replacing an explicit empty selection', () => {
        expect(normalizeSessionListFilterV1({ show: 'runs', startedBy: ['agents', 'triggers', 'agents'] }))
            .toMatchObject({ show: 'runs', startedBy: ['agents', 'triggers'] });
        expect(normalizeSessionListFilterV1({ startedBy: [] }).startedBy).toEqual([]);
    });

    it('requires the current closed filter shape and rejects unknown run facets', () => {
        expect(SessionListFilterV1Schema.safeParse({
            scope: 'my_work', attention: 'any', source: 'all', homeServerIds: [], audiences: [], tagIds: [],
        }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), show: 'everything' }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...normalizeSessionListFilterV1(), startedBy: ['host'] }).success).toBe(false);
    });

    it('does not reset run facets when an Action patches another filter facet', () => {
        expect(ScopeActionInputSchemas['session.list.view.set'].parse({
            filters: { scope: 'all_accessible' },
        }).filters).toEqual({ scope: 'all_accessible' });
    });

    it('normalizes qualified selections without collapsing identities from different Homes', () => {
        const normalized = normalizeSessionListFilterV1({
            scope: 'all_accessible',
            homeServerIds: [' home-b ', '', 'home-a', 'home-b'],
            audiences: [
                { serverId: ' home-a ', kind: 'team', teamId: ' team-a ' },
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a' },
                { serverId: '', kind: 'outside_teams' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: ' group-a ' },
            ],
            tagIds: [
                { serverId: 'home-b', tagId: ' urgent ' },
                { serverId: 'home-b', tagId: 'urgent' },
                { serverId: 'home-a', tagId: 'urgent' },
                { serverId: 'home-a', tagId: '' },
            ],
        });
        expect(normalized).toEqual({
            scope: 'all_accessible', attention: 'any', source: 'all', show: 'both', startedBy: ['you'],
            homeServerIds: ['home-b', 'home-a'],
            audiences: [
                { serverId: 'home-a', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-b', kind: 'team', teamId: 'team-a' },
                { serverId: 'home-a', kind: 'group', teamId: 'team-a', groupId: 'group-a' },
            ],
            tagIds: [{ serverId: 'home-b', tagId: 'urgent' }, { serverId: 'home-a', tagId: 'urgent' }],
        });
        expect(normalizeSessionListFilterV1(normalized)).toEqual(normalized);
    });

    it('parses the serializable schema and delegates normalization to the same owner', () => {
        const filters = { ...normalizeSessionListFilterV1(), homeServerIds: [' home-a ', 'home-a'] };
        expect(SessionListFilterV1Schema.parse(JSON.parse(JSON.stringify(filters))))
            .toEqual({ ...normalizeSessionListFilterV1(), homeServerIds: ['home-a'] });
    });

    it('rejects UI-only state and unknown selection fields at the serializable boundary', () => {
        const filters = normalizeSessionListFilterV1();
        expect(SessionListFilterV1Schema.safeParse({ ...filters, searchQuery: 'draft search' }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({
            ...filters, audiences: [{ serverId: 'home-a', kind: 'team', teamId: 'team-a', access: 'admin' }],
        }).success).toBe(false);
        expect(SessionListFilterV1Schema.safeParse({ ...filters, source: 'unknown' }).success).toBe(false);
    });
});
