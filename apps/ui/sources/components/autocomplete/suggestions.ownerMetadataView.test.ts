import { beforeEach, describe, expect, it, vi } from 'vitest';

const suggestionSessionState = vi.hoisted(() => ({
    current: null as Record<string, unknown> | null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                sessions: suggestionSessionState.current
                    ? { s1: suggestionSessionState.current }
                    : {},
            }),
        },
    });
});

vi.mock('@/sync/ops/sessionCatalogs', () => ({
    ensureSessionSuggestionCatalogs: vi.fn(async () => undefined),
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
}));

describe('autocomplete session catalog owner metadata', () => {
    beforeEach(() => {
        suggestionSessionState.current = null;
    });

    it('reads layout1 catalogs from the owner view instead of strict shared metadata', async () => {
        suggestionSessionState.current = {
            metadataLayoutVersion: 1,
            metadata: {
                sessionVendorPluginCatalogV1: {
                    items: [{
                        name: 'shared-decoy',
                        displayName: 'Shared decoy',
                        vendorPluginRef: 'plugin://shared-decoy',
                        installed: true,
                        enabled: true,
                    }],
                },
            },
            ownerMetadataView: {
                sessionVendorPluginCatalogV1: {
                    items: [{
                        name: 'owner-plugin',
                        displayName: 'Owner plugin',
                        vendorPluginRef: 'plugin://owner-plugin',
                        installed: true,
                        enabled: true,
                    }],
                },
            },
        };
        const { getSuggestions } = await import('./suggestions');

        const suggestions = await getSuggestions('s1', '@plugin:');

        expect(suggestions.map((suggestion) => suggestion.key)).toEqual([
            'vendor-plugin-plugin://owner-plugin',
        ]);
    });

    it('does not fall back to layout1 shared catalogs when the owner view is missing', async () => {
        suggestionSessionState.current = {
            metadataLayoutVersion: 1,
            metadata: {
                sessionSkillCatalogV1: {
                    items: [{
                        name: 'shared-decoy-skill',
                        enabled: true,
                    }],
                },
            },
            ownerMetadataView: null,
        };
        const { getSuggestions } = await import('./suggestions');

        await expect(getSuggestions('s1', '$shared')).resolves.toEqual([]);
    });
});
