import { describe, expect, it } from 'vitest';

import {
    isConnectedServiceItemCollapsed,
    resolveConnectedServiceCollapseKey,
    setConnectedServiceItemCollapsed,
} from './resolveConnectedServiceCollapseKey';

// Variant defaults: accounts expanded (false), pool members collapsed (true).
const ACCOUNT_DEFAULT_COLLAPSED = false;
const MEMBER_DEFAULT_COLLAPSED = true;

describe('resolveConnectedServiceCollapseKey', () => {
    it('namespaces standalone accounts distinctly from pool members', () => {
        expect(
            resolveConnectedServiceCollapseKey({ serviceId: 'claude-subscription', profileId: 'p1' }),
        ).toBe('claude-subscription:account:p1');

        expect(
            resolveConnectedServiceCollapseKey({ serviceId: 'claude-subscription', profileId: 'p1', groupId: 'g1' }),
        ).toBe('claude-subscription:pool:g1:p1');
    });

    it('treats nullish/empty groupId as a standalone account, not a pool member', () => {
        expect(resolveConnectedServiceCollapseKey({ serviceId: 's', profileId: 'p', groupId: null })).toBe(
            's:account:p',
        );
        expect(resolveConnectedServiceCollapseKey({ serviceId: 's', profileId: 'p', groupId: '' })).toBe(
            's:account:p',
        );
    });

    it('does not collide between the same account standalone vs as a pool member', () => {
        const accountKey = resolveConnectedServiceCollapseKey({ serviceId: 's', profileId: 'p' });
        const memberKey = resolveConnectedServiceCollapseKey({ serviceId: 's', profileId: 'p', groupId: 'g' });
        expect(accountKey).not.toBe(memberKey);
    });
});

describe('isConnectedServiceItemCollapsed', () => {
    it('applies the per-variant default when the key is absent', () => {
        expect(isConnectedServiceItemCollapsed({}, 's:account:p', ACCOUNT_DEFAULT_COLLAPSED)).toBe(false);
        expect(isConnectedServiceItemCollapsed({}, 's:pool:g:p', MEMBER_DEFAULT_COLLAPSED)).toBe(true);
        expect(isConnectedServiceItemCollapsed(null, 's:account:p', ACCOUNT_DEFAULT_COLLAPSED)).toBe(false);
        expect(isConnectedServiceItemCollapsed(undefined, 's:pool:g:p', MEMBER_DEFAULT_COLLAPSED)).toBe(true);
    });

    it('honors an explicit stored deviation over the default', () => {
        expect(isConnectedServiceItemCollapsed({ 's:account:p': true }, 's:account:p', ACCOUNT_DEFAULT_COLLAPSED)).toBe(
            true,
        );
        expect(isConnectedServiceItemCollapsed({ 's:pool:g:p': false }, 's:pool:g:p', MEMBER_DEFAULT_COLLAPSED)).toBe(
            false,
        );
    });
});

describe('setConnectedServiceItemCollapsed (sparse map)', () => {
    it('persists only deviations from the variant default', () => {
        // Collapsing an account (default expanded) is a deviation → stored.
        const collapsedAccount = setConnectedServiceItemCollapsed({}, 's:account:p', true, ACCOUNT_DEFAULT_COLLAPSED);
        expect(collapsedAccount).toEqual({ 's:account:p': true });

        // Expanding a pool member (default collapsed) is a deviation → stored.
        const expandedMember = setConnectedServiceItemCollapsed({}, 's:pool:g:p', false, MEMBER_DEFAULT_COLLAPSED);
        expect(expandedMember).toEqual({ 's:pool:g:p': false });
    });

    it('removes the key when the value returns to the variant default', () => {
        const collapsed = setConnectedServiceItemCollapsed({}, 's:account:p', true, ACCOUNT_DEFAULT_COLLAPSED);
        const reExpanded = setConnectedServiceItemCollapsed(collapsed, 's:account:p', false, ACCOUNT_DEFAULT_COLLAPSED);
        expect(reExpanded).toEqual({});
    });

    it('does not mutate the input map', () => {
        const input = { 'a:account:x': true } as const;
        const next = setConnectedServiceItemCollapsed(input, 's:account:p', true, ACCOUNT_DEFAULT_COLLAPSED);
        expect(input).toEqual({ 'a:account:x': true });
        expect(next).toEqual({ 'a:account:x': true, 's:account:p': true });
    });
});

describe('connectedServicesCollapsedItemKeysV1 setting registration', () => {
    it('is a sparse boolean record account setting with a {} default', async () => {
        const { ACCOUNT_CONNECTED_SERVICES_SETTING_DEFINITIONS } = await import(
            '@/sync/domains/settings/registry/account/accountConnectedServicesSettingDefinitions'
        );
        const definition = ACCOUNT_CONNECTED_SERVICES_SETTING_DEFINITIONS.connectedServicesCollapsedItemKeysV1;

        expect(definition.storageScope).toBe('account');
        expect(definition.default).toEqual({});
        expect(definition.schema.safeParse({ 's:account:p': true, 's:pool:g:p': false }).success).toBe(true);
        expect(definition.schema.safeParse({ 's:account:p': 'yes' }).success).toBe(false);
        // Collapse state is UI state, not an analytics setting.
        expect(definition.analytics).toBeUndefined();
    });

    it('is aggregated into the account setting artifacts', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS } = await import(
            '@/sync/domains/settings/registry/account/accountSettingArtifacts'
        );
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).toHaveProperty('connectedServicesCollapsedItemKeysV1');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).toHaveProperty('connectedServicesCollapsedItemKeysV1', {});
    });

    it('is NOT rewritten by server-identity key migration (serviceId:profileId-namespaced, not server-id-prefixed)', async () => {
        const { migrateAccountSettingsServerIdentityKeys } = await import(
            '@/sync/domains/settings/serverIdentityKeyMigration'
        );
        // Even with a server-id-looking legacy value present, the migration must
        // leave the connected-services collapse map untouched.
        const result = migrateAccountSettingsServerIdentityKeys({
            settings: {
                connectedServicesCollapsedItemKeysV1: {
                    'claude-subscription:account:localhost-18829': true,
                },
            },
            currentServerId: 'srv_identity',
            legacyServerIds: ['localhost-18829'],
            rewriteUnknownServerIds: true,
        });

        expect(result.settings.connectedServicesCollapsedItemKeysV1).toEqual({
            'claude-subscription:account:localhost-18829': true,
        });
        expect(result.changedKeys).not.toContain('connectedServicesCollapsedItemKeysV1');
    });
});
