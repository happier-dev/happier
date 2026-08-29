import { describe, expect, it } from 'vitest';

import {
    areExactTurnAutomationPrefillsEqual,
    parseExactTurnAutomationPrefillRoute,
    readExactActiveParentTurn,
} from './exactTurnAutomationPrefill';

describe('exactTurnAutomationPrefill', () => {
    const session = { id: 'session-1', serverId: 'server-1', latestTurnId: 'turn-1', latestTurnStatus: 'in_progress' as const };

    it('captures only the exact observed in-progress parent turn', () => {
        const observed = readExactActiveParentTurn(session as any);
        expect(observed).toEqual({ sourceSessionId: 'session-1', sourceTurnId: 'turn-1', sourceServerId: 'server-1' });
        expect(readExactActiveParentTurn({ ...session, latestTurnStatus: 'completed' } as any)).toBeNull();
        expect(readExactActiveParentTurn({ ...session, latestTurnId: null } as any)).toBeNull();
    });

    it('parses a complete route tuple as the exact observed identity', () => {
        const route = parseExactTurnAutomationPrefillRoute({
            sourceSessionId: ' session-1 ',
            sourceTurnId: ' turn-1 ',
            sourceServerId: ' server-1 ',
        });
        expect(route.kind).toBe('valid');
        if (route.kind !== 'valid') return;
        expect(areExactTurnAutomationPrefillsEqual(route.prefill, readExactActiveParentTurn(session as any))).toBe(true);
        expect(areExactTurnAutomationPrefillsEqual(route.prefill, { ...route.prefill, sourceTurnId: 'turn-2' })).toBe(false);
    });

    it('treats a route with no exact-turn members as absent generic authoring', () => {
        expect(parseExactTurnAutomationPrefillRoute({})).toEqual({ kind: 'absent' });
    });

    it('fails an all-present but blank exact-turn tuple closed', () => {
        expect(parseExactTurnAutomationPrefillRoute({
            sourceSessionId: '   ',
            sourceTurnId: '',
            sourceServerId: undefined,
        })).toEqual({ kind: 'invalid' });
    });

    it.each([
        ['sourceSessionId only', { sourceSessionId: 'session-1' }],
        ['sourceTurnId only', { sourceTurnId: 'turn-1' }],
        ['sourceServerId only', { sourceServerId: 'server-1' }],
        ['session and turn without server', { sourceSessionId: 'session-1', sourceTurnId: 'turn-1' }],
        ['session and server without turn', { sourceSessionId: 'session-1', sourceServerId: 'server-1' }],
        ['turn and server without session', { sourceTurnId: 'turn-1', sourceServerId: 'server-1' }],
        ['blank member among present members', {
            sourceSessionId: 'session-1',
            sourceTurnId: '   ',
            sourceServerId: 'server-1',
        }],
        ['array-valued member', {
            sourceSessionId: ['session-1'],
            sourceTurnId: 'turn-1',
            sourceServerId: 'server-1',
        }],
        ['non-string member', {
            sourceSessionId: 17,
            sourceTurnId: 'turn-1',
            sourceServerId: 'server-1',
        }],
    ])('fails a partial exact-turn intent closed (%s)', (_name, params) => {
        expect(parseExactTurnAutomationPrefillRoute(params as Record<string, unknown>)).toEqual({ kind: 'invalid' });
    });
});
