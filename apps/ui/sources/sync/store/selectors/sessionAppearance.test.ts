import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { createCustomSessionAppearanceColorsSelector, selectEffectiveSessionAppearanceColor, selectSessionAppearancesSupported, type SessionAppearanceSelectorState } from './sessionAppearance';
import { createSessionListRowStoreStateSelector, selectSessionListRowStateSnapshot } from '../sessionListRowStateSnapshot';

describe('appearance selectors', () => {
    it('inherits only the foreign row own workspace, not an active-Home project sharing its session id', () => {
        const metadata = { machineId: 'machine-a', path: '/foreign' };
        const workspaceKey = resolveSessionWorkspacePresentation({ metadata, machines: {} }).workspaceKey;
        const label = { labelKind: 'workspace', scopeKey: workspaceKey, display: { t: 'plain', v: { label: 'Foreign', color: { kind: 'accent', key: 'green' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 } as const;
        const state: SessionAppearanceSelectorState = {
            getProjectForSession: () => ({ key: { machineId: 'machine-a', path: '/active' } }),
            sessionOrganizationLabelsByLabelKey: { [`server-b:workspace:${workspaceKey}`]: label },
        };
        const params = { serverId: 'server-b', activeServerId: 'server-a', sessionId: 'same-id', metadata };
        expect(selectEffectiveSessionAppearanceColor(state, params)).toEqual({ kind: 'accent', key: 'green' });
    });
    it('deduplicates normalized custom colours across sessions/workspaces and excludes other servers, archived labels and junk', () => {
        const selector = createCustomSessionAppearanceColorsSelector('server-a');
        const label = { labelKind: 'workspace', scopeKey: 'wl_a', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#abc' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 } as const;
        const state: SessionAppearanceSelectorState = {
            sessionOrganizationLabelsByLabelKey: { 'server-a:workspace:wl_a': label, archived: { ...label, archivedAt: 10, display: { t: 'plain', v: { color: { kind: 'custom', hex: '#001122' } } } } },
            sessionOrganizationAppearancesBySessionKey: {
                'server-a:s1': { sessionId: 's1', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#AABBCC' } } }, updatedAt: 1 },
                'server-a:s2': { sessionId: 's2', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#112233' } } }, updatedAt: 1 },
                'server-b:s3': { sessionId: 's3', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#FFFFFF' } } }, updatedAt: 1 },
            },
        };
        const colors = selector(state);
        expect(colors).toEqual(['#112233', '#AABBCC']);
        expect(selector({ ...state, sessionOrganizationLabelsByLabelKey: { ...state.sessionOrganizationLabelsByLabelKey } })).toBe(colors);
        expect(selectSessionAppearancesSupported(state, 'server-a')).toBe(false);
    });

    it('updates only the affected row projection and reveals the workspace colour after clearing a session override', () => {
        const session = createSessionFixture({ id: 's1' });
        const workspaceKey = resolveSessionWorkspacePresentation({ metadata: session.metadata, machines: {} }).workspaceKey;
        const label = { labelKind: 'workspace', scopeKey: workspaceKey, display: { t: 'plain', v: { color: { kind: 'accent', key: 'blue' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 } as const;
        const state = { sessions: { s1: session }, sessionOrganizationLabelsByLabelKey: { [`server-a:workspace:${workspaceKey}`]: label } };
        const params = { serverId: 'server-a', sessionId: 's1', metadata: session.metadata };
        const select = createSessionListRowStoreStateSelector([params], 'server-a');
        const first = select(state);
        expect(selectSessionListRowStateSnapshot(first, params).appearanceColor).toEqual({ kind: 'accent', key: 'blue' });
        const appearance = { sessionId: 's1', display: { t: 'plain', v: { color: { kind: 'custom', hex: '#123456' } } }, updatedAt: 1 } as const;
        expect(select({ ...state, sessionOrganizationAppearancesBySessionKey: { 'server-a:other': { ...appearance, sessionId: 'other' } } })).toBe(first);
        const override = { ...state, sessionOrganizationAppearancesBySessionKey: { 'server-a:s1': appearance } };
        expect(selectEffectiveSessionAppearanceColor(override, params)).toEqual({ kind: 'custom', hex: '#123456' });
        const changed = select(override);
        expect(changed).not.toBe(first);
        expect(select({ ...override, sessionOrganizationAppearancesBySessionKey: structuredClone(override.sessionOrganizationAppearancesBySessionKey) })).toBe(changed);
        expect(selectEffectiveSessionAppearanceColor(state, params)).toEqual({ kind: 'accent', key: 'blue' });
        expect(selectEffectiveSessionAppearanceColor(state, { ...params, serverId: 'server-b' })).toBeNull();
    });
});
