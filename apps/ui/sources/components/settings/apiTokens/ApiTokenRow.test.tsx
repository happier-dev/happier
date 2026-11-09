import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
const { ApiTokenRow } = await import('./ApiTokenRow');

afterEach(() => standardCleanup());

const NOW = Date.parse('2026-08-22T12:00:00.000Z');
const names = { familyName: () => null, actionName: () => null, modelName: () => null, automationName: () => null };
const token = (overrides: Record<string, unknown> = {}) => ({
    tokenId: '11111111-1111-4111-8111-111111111111', label: 'CI', displayPrefix: 'hap_v1_11111111',
    createdAt: new Date(NOW - 30_000).toISOString(), lastUsedAt: null, expiresAt: null,
    hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: API_TOKEN_FULL_GRANT_V1,
    parentTokenId: null, activeChildCount: 0, embedConfig: null, ...overrides,
}) as never;
const render = (overrides: Record<string, unknown>) => renderScreen(
    <ApiTokenRow token={token(overrides)} names={names} nowMs={NOW} variant="rail" onPress={() => {}} />,
);
const glyphs = (screen: Awaited<ReturnType<typeof render>>) => screen.tree.findAll((node) => node.props.accessibilityRole === 'image');

describe('ApiToken row', () => {
    it('says an expiry that needs the person in the icon-only status slot, not in a pill beside the name', async () => {
        const expiring = await render({ expiresAt: new Date(NOW + 30_000).toISOString() });
        const status = expiring.findHostByTestId('settings-api-tokens-status:11111111-1111-4111-8111-111111111111');
        expect(status?.props.accessibilityRole).toBe('image');
        expect(status?.props.accessibilityLabel).toBe('settingsApiTokens.status.expiresInMinutes(count=1)');
        const expired = await render({ expiresAt: new Date(NOW - 30_000).toISOString() });
        expect(glyphs(expired).map((node) => node.props.accessibilityLabel)).toContain('settingsApiTokens.status.expired');
    });

    it('keeps an ordinary token quiet and lets an embed token lead its context line with its kind', async () => {
        const plain = await render({});
        expect(glyphs(plain)).toHaveLength(0);
        expect(plain.getTextContent()).not.toContain('settingsApiTokens.embedPill');
        const embed = await render({ embedConfig: {} });
        expect(embed.findByTestId('settings-api-tokens-embed:11111111-1111-4111-8111-111111111111')).toBeNull();
        expect(embed.getTextContent()).toContain('settingsApiTokens.embedPill');
    });
});
