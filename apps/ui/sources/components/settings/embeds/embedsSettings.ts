import { defineSettingsPage, type SettingsRouteContext } from '@/components/settings/catalog/settingDeclarations';

import { EMBEDS_COLLECTION_ROOT, EMBEDS_NEW_PATH, embedDetailPath, resolveSelectedEmbedTokenId } from './embedsCollection';

/**
 * Where an embed's settings live: the embed being viewed (or the one being created). Search offers
 * these rows only while one is open, because each embed has its own; with none open they are omitted.
 */
function resolveEmbedSettingsRoute(context: SettingsRouteContext): string | null {
    const pathname = context.pathname.replace(/\/+$/, '');
    if (pathname === EMBEDS_NEW_PATH) return EMBEDS_NEW_PATH;
    if (!pathname.startsWith(`${EMBEDS_COLLECTION_ROOT}/`)) return null;
    const tokenId = resolveSelectedEmbedTokenId(pathname);
    return tokenId ? embedDetailPath(tokenId) : null;
}

/** Settings → Embeds detail's searchable settings. Rows render their labels from these declarations. */
export const EMBED_SETTINGS = defineSettingsPage({
    pageId: 'embeds',
    subpage: { id: 'embed', route: resolveEmbedSettingsRoute, titleKey: 'settingsEmbeds.title' },
    sections: {
        sites: {
            titleKey: 'settingsEmbeds.sites.title',
            settings: {
                sites: {},
            },
        },
        capabilities: {
            titleKey: 'settingsEmbeds.capabilities.title',
            settings: {
                send: {},
                approve: {},
                changeModel: {},
                permissionModes: {},
            },
        },
        models: {
            titleKey: 'settingsEmbeds.models.title',
            settings: {
                // The section's description already says what the restriction does; the row repeats nothing.
                allowedModels: {},
            },
        },
        organization: {
            titleKey: 'settingsEmbeds.organization.title',
            settings: {
                folder: {},
                tags: {},
            },
        },
        composer: {
            titleKey: 'settingsEmbeds.composer.title',
            settings: {
                attachments: {},
            },
        },
        sessions: {
            titleKey: 'settingsEmbeds.sessions.title',
            settings: {
                createSessions: {},
                newChat: {},
            },
        },
        appearance: {
            titleKey: 'settingsEmbeds.appearance.title',
            settings: {
                mode: {},
                theme: {},
                colors: {},
                fontFamily: {},
                fontFile: {},
                textSize: {},
                corners: {},
                density: {},
            },
        },
    },
});
