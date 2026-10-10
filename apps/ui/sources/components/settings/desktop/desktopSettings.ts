import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { LOCAL_SETTING_DEFINITIONS } from '@/sync/domains/settings/registry/local/localSettingDefinitions';
import { AUTO_HIDE_DELAY_OPTIONS } from './desktopOverlayAutoHideDelayOptions';
import { commitDesktopOverlayPlacement } from './desktopOverlayPlacement';

const placementSchema = LOCAL_SETTING_DEFINITIONS.desktopOverlayPlacementMode.schema;
const anchorSchema = LOCAL_SETTING_DEFINITIONS.desktopOverlayAnchor.schema;

/**
 * The searchable settings of the `desktop` page. Rows render their labels from these declarations.
 * Everything here exists only in the desktop app; the overlay rows below `enabled` also wait on it.
 */
export const DESKTOP_SETTINGS = defineSettingsPage({
    pageId: 'desktop',
    sections: {
        startup: {
            titleKey: 'settingsDesktop.startupTitle',
            host: settingsHosts.desktop,
            settings: {
                startOnLogin: {},
            },
        },
        overlay: {
            titleKey: 'settingsDesktop.overlay.title',
            host: settingsHosts.desktop,
            settings: {
                enabled: {},
                visibilityMode: {},
                showWhenRunning: {},
                showWhenAttentionRequired: {},
                showWhenReady: {},
                alwaysOnTop: {},
            },
        },
        interaction: {
            titleKey: 'settingsDesktop.overlay.interactionTitle',
            host: settingsHosts.desktop,
            settings: {
                autoHideEnabled: {},
                autoHideDelay: {},
            },
        },
        placement: {
            titleKey: 'settingsDesktop.overlay.placementTitle',
            host: settingsHosts.desktop,
            settings: {
                presentationMode: {},
                placementMode: {
                    storage: { scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: placementSchema.options,
                        read: local => local.desktopOverlayPlacementMode,
                        parse: value => { const parsed = placementSchema.safeParse(value); return parsed.success ? { success: true, value: parsed.data } : { success: false }; },
                        commit: (_local, value, writeLocal) => commitDesktopOverlayPlacement({ kind: 'mode', value: placementSchema.parse(value) }, writeLocal) } },
                anchorPreset: {
                    storage: { scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: anchorSchema.options,
                        read: local => local.desktopOverlayAnchor,
                        parse: value => { const parsed = anchorSchema.safeParse(value); return parsed.success ? { success: true, value: parsed.data } : { success: false }; },
                        commit: (_local, value, writeLocal) => commitDesktopOverlayPlacement({ kind: 'anchor', value: anchorSchema.parse(value) }, writeLocal) } },
                resetPosition: {},
                allowRepositioning: {},
                lockPosition: {},
            },
        },
        presentation: {
            titleKey: 'settingsDesktop.overlay.presentationTitle',
            host: settingsHosts.desktop,
            settings: {
                showPreviewText: {},
            },
        },
    },
});
