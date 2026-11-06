import { describe, expect, it } from 'vitest';
import type { UiSessionOrganizationLabel, UiSessionOrganizationSessionAppearance } from '@/sync/domains/session/organization/types';
import { buildSessionOrganizationLabelKey, buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { createCustomSessionAppearanceColorsSelector, createEffectiveSessionAppearanceColorsSelector, selectEffectiveSessionAppearanceColor, selectSessionAppearancesSupported } from './sessionAppearance';

function appearance(sessionId: string, hex: string): UiSessionOrganizationSessionAppearance {
    return { sessionId, updatedAt: 1, display: { t: 'plain', v: { color: { kind: 'custom', hex } } }, displayState: { status: 'available', value: null } };
}
function label(scopeKey: string, hex: string): UiSessionOrganizationLabel {
    return { labelKind: 'workspace', scopeKey, createdAt: 1, updatedAt: 1, archivedAt: null, display: { t: 'plain', v: { color: { kind: 'custom', hex } } }, displayState: { status: 'available', value: null } };
}

describe('Session appearance selectors', () => {
    it('selects projected inheritance before appearance records have arrived', () => {
        const color = { kind: 'accent', key: 'blue' } as const;
        const select = createEffectiveSessionAppearanceColorsSelector([{ serverId: 'a', sessionId: 's', workspaceColor: color }]);
        expect(select({}).get(buildSessionOrganizationSessionKey('a', 's'))).toBe(color);
    });
    it('scopes same-id sessions to their Home and reveals workspace colour when cleared', () => {
        const own = appearance('s', '#abc');
        const workspace = label('workspace', '#123');
        const state = {
            sessionOrganizationAppearancesBySessionKey: { [buildSessionOrganizationSessionKey('a:1', 's')]: own },
            sessionOrganizationLabelsByLabelKey: { [buildSessionOrganizationLabelKey({ serverId: 'b', labelKind: 'workspace', scopeKey: 'workspace' })]: workspace },
        };
        const input = { serverId: 'b', sessionId: 's', workspaceKey: 'workspace' };
        expect(selectEffectiveSessionAppearanceColor(state, input)).toEqual({ kind: 'custom', hex: '#112233' });
        expect(selectEffectiveSessionAppearanceColor(state, { ...input, serverId: 'a:1' })).toEqual({ kind: 'custom', hex: '#AABBCC' });
        expect(selectSessionAppearancesSupported(state, 'b')).toBe(false);
        expect(selectSessionAppearancesSupported({ sessionOrganizationSessionAppearancesSupportedByServerId: { b: true } }, ' b ')).toBe(true);
    });

    it('returns stable distinct custom colours in use and excludes archived, locked and other Homes', () => {
        const a = appearance('s', '#abc');
        const state = { sessionOrganizationAppearancesBySessionKey: {
            [buildSessionOrganizationSessionKey('a', 's')]: a,
            [buildSessionOrganizationSessionKey('a:other', 's')]: appearance('s', '#def'),
        }, sessionOrganizationLabelsByLabelKey: {
            [buildSessionOrganizationLabelKey({ serverId: 'a', labelKind: 'workspace', scopeKey: 'w' })]: label('w', '#aabbcc'),
            [buildSessionOrganizationLabelKey({ serverId: 'a', labelKind: 'workspace', scopeKey: 'archived' })]: { ...label('archived', '#123'), archivedAt: 2 },
            [buildSessionOrganizationLabelKey({ serverId: 'a', labelKind: 'workspace', scopeKey: 'locked' })]: { ...label('locked', '#456'), displayState: { status: 'locked' as const, reason: 'account_key_unavailable' as const } },
        } };
        const select = createCustomSessionAppearanceColorsSelector('a');
        const first = select(state);
        expect(first).toEqual(['#AABBCC']);
        expect(select({ ...state, sessionOrganizationAppearancesBySessionKey: { ...state.sessionOrganizationAppearancesBySessionKey } })).toBe(first);
        expect(select({ ...state, sessionOrganizationAppearancesBySessionKey: {} })).toBe(first);
        expect(select({ sessionOrganizationAppearancesBySessionKey: {}, sessionOrganizationLabelsByLabelKey: {} })).toEqual([]);
    });
});
