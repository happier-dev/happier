import { describe, expect, it } from 'vitest';
import { SessionOrganizationChangeHintSchema } from '@happier-dev/protocol/changes';
import { buildSessionOrganizationHint } from './changes';
import { mapSessionAppearance } from './organizationSnapshot';

describe('personal appearance display projection', () => {
    it('publishes an appearance change hint accepted by the shared protocol reader', () => {
        const hint = buildSessionOrganizationHint({ scope: 'sessionAppearances', sessionIds: ['s1'] });
        expect(SessionOrganizationChangeHintSchema.parse(hint)).toEqual({
            sessionOrganization: true, scope: 'sessionAppearances', sessionIds: ['s1'],
        });
    });

    it('uses the existing unavailable projection instead of disclosing mismatched content', () => {
        const row = { sessionId: 's1', updatedAt: new Date(10), displayDbValue: '{not-json' };
        expect(mapSessionAppearance(row, 'plain')).toEqual({ sessionId: 's1', updatedAt: 10, display: null,
            displayState: { status: 'unavailable', reason: 'invalid_stored_display' } });
        expect(mapSessionAppearance({ ...row, displayDbValue: JSON.stringify({ t: 'encrypted', c: 'opaque' }) }, 'plain'))
            .toEqual({ sessionId: 's1', updatedAt: 10, display: null,
                displayState: { status: 'unavailable', reason: 'storage_mode_mismatch' } });
        const display = { t: 'plain', v: { color: '#123456' } };
        expect(mapSessionAppearance({ ...row, displayDbValue: JSON.stringify(display) }, 'plain'))
            .toEqual({ sessionId: 's1', updatedAt: 10, display });
    });
});
