import { describe, expect, it } from 'vitest';

import { buildSettingHref, collectDeclaredFeatureIds, defineSettingsPage } from './settingDeclarations';
import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { SOURCE_CONTROL_SETTINGS } from '@/components/settings/sourceControl/sourceControlSettings';
import { COORDINATION_SETTINGS } from '@/components/settings/coordination/coordinationSettings';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';

describe('scoped setting links', () => {
    it.each(['managerPolicy', 'runReportPolicy', 'discussionReceivePolicy'] as const)('discovers and links the %s creation default through the Follow owner', field => {
        const anchor = `coordination.${field}`;
        const ref = Object.values(COORDINATION_SETTINGS.settings).find(setting => setting.anchor === anchor);
        expect(ref).toBeDefined();
        expect(readBuiltInSettingDeclarationV1(anchor)).toMatchObject({ pageId: 'coordination', targetKinds: ['home'],
            storage: { scope: 'home', kind: 'sessionAutoFollowPreferences', field, access: 'read_write' } });
        expect(buildSettingHref('/settings/coordination', ref!)).toBe(`/settings/coordination?setting=${anchor}`);
    });
    it('places Sessions attention and status controls in their declared sections without changing search anchors', () => {
        for (const [setting, section, titleKey] of [
            [SESSION_SETTINGS.settings.attentionPromotion, SESSION_SETTINGS.sectionRefs.listOrganization,
                'settingsSession.rootGroups.listOrganization.title'],
            [SESSION_SETTINGS.settings.statusWords, SESSION_SETTINGS.sectionRefs.rowDetails,
                'settingsSession.rootGroups.rowDetails.title'],
        ] as const) {
            expect(setting.sectionId).toBe(section.id);
            expect(setting.sectionTitleKey).toBe(titleKey);
            expect(section.settingAnchors).toContain(setting.anchor);
            expect(SESSION_SETTINGS.sectionRefs.activitySignals.settingAnchors).not.toContain(setting.anchor);
        }
        expect(buildSettingHref('/settings/session', SESSION_SETTINGS.settings.attentionPromotion))
            .toBe('/settings/session?setting=session.list.attentionPlacement');
        expect(buildSettingHref('/settings/session', SESSION_SETTINGS.settings.statusWords))
            .toBe('/settings/session?setting=session.list.statusWords');
    });
    it('keeps a mixed section’s feature decisions per row regardless of row order', () => {
        const mixed = defineSettingsPage({ pageId: 'sourceControl', sections: { files: { settings: {
            showLineNumbersInDiffs: {},
            trackAgentEdits: { anchor: 'files.trackAgentEdits' },
        } } } });
        expect(mixed.settings.showLineNumbersInDiffs.featureId).toBe('scm.writeOperations');
        expect(mixed.settings.trackAgentEdits.featureId).toBeUndefined();
        // This isolated mixed section must still request the feature snapshot for its SCM row.
        expect(collectDeclaredFeatureIds([mixed])).toEqual(['scm.writeOperations']);
    });
    it('keeps Track’s canonical settings Action anchor when its row lives on the source-control page', () => {
        const ref = SOURCE_CONTROL_SETTINGS.settings.trackAgentEdits;
        expect(ref).toMatchObject({ anchor: 'files.trackAgentEdits', sectionId: 'sourceControl.files',
            storage: { scope: 'local', key: 'filesTrackAgentEdits', access: 'read_write' } });
        expect(buildSettingHref('/settings/source-control', ref)).toBe('/settings/source-control?setting=files.trackAgentEdits');
        expect(() => defineSettingsPage({ pageId: 'sourceControl', sections: { files: { settings: {
            one: { anchor: 'files.trackAgentEdits' }, two: { anchor: 'files.trackAgentEdits' },
        } } } })).toThrow('Duplicate setting anchor');
    });
    it('projects the MCP failure policy from its Sessions declaration and links to that page', () => {
        const setting = SESSION_SETTINGS.settings.mcpServersStrictMode;
        expect(setting).toMatchObject({ anchor: 'session.mcpServersStrictMode',
            storage: { scope: 'account', key: 'mcpServersStrictMode', access: 'read_write' } });
        expect(SESSION_SETTINGS.sectionRefs.mcpServersReliability.id).toBe('session.mcpServersReliability');
        expect(buildSettingHref('/settings/session', setting)).toBe('/settings/session?setting=session.mcpServersStrictMode');
    });
    it('uses explicit route context and omits a setting when its destination is unavailable', () => {
        const ref = { anchor: 'teams.oidc.issuer' };
        const route = (context: Readonly<{ pathname: string; params: Readonly<Record<string, string | string[] | undefined>> }>) => (
            context.pathname === '/settings/teams/home-b/team-one/authentication/connection-one/edit'
            && context.params.providerId === 'provider-one'
                ? `${context.pathname}?providerId=provider-one`
                : null
        );
        const context = {
            pathname: '/settings/teams/home-b/team-one/authentication/connection-one/edit',
            params: { providerId: 'provider-one' },
        };

        expect(buildSettingHref(route, ref, context)).toBe(`${context.pathname}?providerId=provider-one&setting=teams.oidc.issuer`);
        expect(buildSettingHref(route, ref, { ...context, pathname: '/settings' })).toBeNull();
        expect(buildSettingHref(route, ref)).toBeNull();
        expect(buildSettingHref('/settings/session?mode=resume', ref)).toBe('/settings/session?mode=resume&setting=teams.oidc.issuer');
    });
});

describe('a sub-page that keeps its catalog page anchors', () => {
    it('keeps the shared ids of rows that moved to a sub-page route', () => {
        const moved = defineSettingsPage({
            pageId: 'appearance',
            subpage: { id: 'motion', route: '/settings/appearance/motion', titleKey: 'settingsAppearance.visualEffects.title', anchors: 'page' },
            sections: { loadingIndicator: { settings: { loadingIndicatorStyle: {} } } },
        });

        expect(moved.settings.loadingIndicatorStyle.anchor).toBe('appearance.loadingIndicatorStyle');
        expect(moved.sectionRefs.loadingIndicator.id).toBe('appearance.loadingIndicator');
        expect(buildSettingHref(moved.subpage!.route, moved.settings.loadingIndicatorStyle))
            .toBe('/settings/appearance/motion?setting=appearance.loadingIndicatorStyle');
    });
});
