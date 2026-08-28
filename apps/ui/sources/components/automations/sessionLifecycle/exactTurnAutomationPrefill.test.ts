import { describe, expect, it } from 'vitest';

import { areExactTurnAutomationPrefillsEqual, parseExactTurnAutomationPrefill, readExactActiveParentTurn } from './exactTurnAutomationPrefill';

describe('exactTurnAutomationPrefill', () => {
    const session = { id: 'session-1', serverId: 'server-1', latestTurnId: 'turn-1', latestTurnStatus: 'in_progress' as const };

    it('captures only the exact observed in-progress parent turn', () => {
        const observed = readExactActiveParentTurn(session as any);
        expect(observed).toEqual({ sourceSessionId: 'session-1', sourceTurnId: 'turn-1', sourceServerId: 'server-1' });
        expect(readExactActiveParentTurn({ ...session, latestTurnStatus: 'completed' } as any)).toBeNull();
        expect(readExactActiveParentTurn({ ...session, latestTurnId: null } as any)).toBeNull();
    });

    it('preserves exact identity across route parsing', () => {
        const parsed = parseExactTurnAutomationPrefill({ sourceSessionId: ' session-1 ', sourceTurnId: ' turn-1 ', sourceServerId: ' server-1 ' });
        expect(areExactTurnAutomationPrefillsEqual(parsed, readExactActiveParentTurn(session as any))).toBe(true);
        expect(areExactTurnAutomationPrefillsEqual(parsed, { ...parsed!, sourceTurnId: 'turn-2' })).toBe(false);
    });
});
