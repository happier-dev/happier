import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { SETTINGS_PAGE_DECLARATIONS } from './settingsPageDeclarations';
import { buildSettingHref } from './settingDeclarations';
import { SETTINGS_ROUTES } from './routes';

function declared(anchor: string) {
    const page = SETTINGS_PAGE_DECLARATIONS.find((candidate) => Object.values(candidate.settings).some((setting) => setting.anchor === anchor));
    expect(page, `Search must declare ${anchor}`).toBeDefined();
    return { page: page!, setting: Object.values(page!.settings).find((setting) => setting.anchor === anchor)! };
}

describe('API tokens and Embeds settings search', () => {
    it('declares the API tokens page rows', () => {
        const { page, setting } = declared('apiTokens.revokeAll');
        expect(page.subpage).toBeUndefined();
        expect(buildSettingHref(SETTINGS_ROUTES.apiTokens, setting)).toBe(`${SETTINGS_ROUTES.apiTokens}?setting=apiTokens.revokeAll`);
        // The CLI/daemon approvals switch is retired: a terminal login is always the person.
        expect(SETTINGS_PAGE_DECLARATIONS.some((candidate) => Object.values(candidate.settings).some((entry) => entry.anchor.endsWith('.cliApprovals')))).toBe(false);
    });

    it('offers an embed’s rows for the embed that is open, and none when no embed is open', () => {
        const { page, setting } = declared('embeds.embed.approve');
        const route = page.subpage!.route;
        const detail = `${SETTINGS_ROUTES.embeds}/11111111-1111-4111-8111-111111111111`;
        expect(buildSettingHref(route, setting, { pathname: detail, params: {} })).toBe(`${detail}?setting=embeds.embed.approve`);
        expect(buildSettingHref(route, setting, { pathname: `${SETTINGS_ROUTES.embeds}/new`, params: {} })).toBe(`${SETTINGS_ROUTES.embeds}/new?setting=embeds.embed.approve`);
        expect(buildSettingHref(route, setting, { pathname: SETTINGS_ROUTES.embeds, params: {} })).toBeNull();
        expect(buildSettingHref(route, setting, { pathname: '/settings', params: {} })).toBeNull();
        for (const anchor of ['embeds.embed.sites', 'embeds.embed.allowedModels', 'embeds.embed.createSessions', 'embeds.embed.colors']) declared(anchor);
    });
});
