import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { themeModeStorageBinding } from './themeModeSettingBinding';
import { glassIntensityStorageBinding, glassPresetStorageBinding, glassSurfaceStorageBinding } from './glassSettingBindings';
import { navigationPlacementStorageBinding } from './navigationPlacementSettingBinding';
import { surfaceFinishOverrideStorageBinding } from './surfaceFinishSettingBindings';

/** Appearance's searchable settings. Rows render their labels from these declarations. */
export const APPEARANCE_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    sections: {
        personalize: {
            settings: {
                // Opens the guided flow from Appearance (lab personalize R3); the choices it walks
                // through are each declared on their own page.
                personalize: {

                    operation: { requiresHumanInteraction: true, kind: 'interaction' },
                },
            },
        },
        theme: {
            titleKey: 'settingsAppearance.theme',
            settings: {
                themeMode: { storage: themeModeStorageBinding },
                themes: {},
                themeToggle: {},
            },
        },
        surfaceFinish: {
            titleKey: 'settingsAppearance.surfaceFinish.title',
            settings: {
                surfaceFinish: {},
                surfaceFinishCustomize: {},
                surfaceFinishCard: { storage: surfaceFinishOverrideStorageBinding('card') },
                surfaceFinishFloating: { storage: surfaceFinishOverrideStorageBinding('floating') },
                surfaceFinishComposer: { storage: surfaceFinishOverrideStorageBinding('composer') },
                surfaceFinishPrimaryButton: { storage: surfaceFinishOverrideStorageBinding('primaryButton') },
                surfaceFinishSecondaryButton: { storage: surfaceFinishOverrideStorageBinding('secondaryButton') },
            },
        },
        text: {
            titleKey: 'settingsAppearance.text',
            settings: {
                textSize: {},
                density: {},
            },
        },
        display: {
            titleKey: 'settingsAppearance.display',
            settings: {
                contentWidth: {},
                editorTabs: {},
                rightPanels: {},
                settingsSidebar: {},
                navigationPlacements: { storage: navigationPlacementStorageBinding },
            },
        },
        home: {
            titleKey: 'settingsOverview.homeLayoutSectionTitle',
            settings: {
                homeSections: {},
            },
        },
        widgets: {
            titleKey: 'widgetFrame.appearanceTitle',
            settings: {
                widgetFrameHome: {},
                widgetFrameBoard: {},
                widgetFrameCompanion: {},
            },
        },
        sessions: {
            titleKey: 'tabs.sessions',
            settings: {
                avatarStyle: {},
                agentIcons: {},
                alwaysShowContextSize: {},
            },
        },
        tabBar: {
            titleKey: 'settingsAppearance.tabBarAppearance.title',
            settings: {
                tabBarSize: {},
                tabBarLabels: {},
                tabBarBadges: {},
                tabBarGitBadge: {},
                tabBarFriendsBadge: {},
                tabBarSessionsBadge: {},
                tabBarInboxBadge: {},
                tabBarOpenTabsBadge: {},
            },
        },
        loadingIndicator: {
            titleKey: 'settingsAppearance.loadingIndicator',
            settings: {
                loadingIndicatorStyle: {},
                loadingIndicatorSpeed: {},
                loadingIndicatorPause: {},
            },
        },
        privacy: {
            titleKey: 'connectedServicesCollection.privacyTitle',
            settings: {
                hideAccountIdentities: {},
            },
        },
        glass: {
            titleKey: 'settingsAppearance.glassControls.title',
            settings: {
                glassPreset: { storage: glassPresetStorageBinding },
                glassIntensity: { storage: glassIntensityStorageBinding },
                glassCustomize: {},
                glassChromeBlur: { storage: glassSurfaceStorageBinding('chrome', 'blur') },
                glassChromeOpacity: { host: settingsHosts.web, storage: glassSurfaceStorageBinding('chrome', 'opacity') },
                glassSidebarBlur: { storage: glassSurfaceStorageBinding('sidebar', 'blur') },
                glassSidebarOpacity: { host: settingsHosts.web, storage: glassSurfaceStorageBinding('sidebar', 'opacity') },
                glassContentBlur: { storage: glassSurfaceStorageBinding('content', 'blur') },
                glassContentOpacity: { host: settingsHosts.web, storage: glassSurfaceStorageBinding('content', 'opacity') },
                glassFloatingBlur: { storage: glassSurfaceStorageBinding('floating', 'blur') },
                glassFloatingOpacity: { host: settingsHosts.web, storage: glassSurfaceStorageBinding('floating', 'opacity') },
            },
        },
    },
});
