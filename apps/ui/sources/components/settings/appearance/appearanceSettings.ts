import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { themeModeStorageBinding } from './themeModeSettingBinding';
import { glassIntensityStorageBinding, glassPresetStorageBinding, glassSurfaceStorageBinding } from './glassSettingBindings';
import { navigationPlacementStorageBinding } from './navigationPlacementSettingBinding';

/** Appearance's searchable settings. Rows render their labels from these declarations. */
export const APPEARANCE_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    sections: {
        personalize: {
            settings: {
                // Opens the guided flow from Appearance (lab personalize R3); the choices it walks
                // through are each declared on their own page.
                personalize: {
                    titleKey: 'personalize.replayTitle',
                    descriptionKey: 'personalize.replaySubtitle',
                    operation: { requiresHumanInteraction: true, kind: 'interaction' },
                },
            },
        },
        theme: {
            titleKey: 'settingsAppearance.theme',
            settings: {
                themeMode: { titleKey: 'settingsAppearance.theme', keywordKeys: ['settingsAppearance.themeOptions.light', 'settingsAppearance.themeOptions.dark'], storage: themeModeStorageBinding },
                themes: { titleKey: 'settingsAppearance.themeProfiles.title' },
                themeToggle: { titleKey: 'settingsAppearance.glassControls.toolbarTitle', descriptionKey: 'settingsAppearance.glassControls.toolbarDescription', storage: { scope: 'local', key: 'titleStripThemeToggleVisible', access: 'read_write' } },
            },
        },
        text: {
            titleKey: 'settingsAppearance.text',
            settings: {
                textSize: { titleKey: 'settingsAppearance.textSize', descriptionKey: 'settingsAppearance.textSizeDescription', storage: { scope: 'local', key: 'uiFontScale', access: 'read_write', allowedValues: Object.values(UI_FONT_SCALE_PRESETS) } },
                density: { titleKey: 'settingsAppearance.itemDensity', descriptionKey: 'settingsAppearance.itemDensityDescription', storage: { scope: 'local', key: 'uiItemDensity', access: 'read_write' } },
            },
        },
        display: {
            titleKey: 'settingsAppearance.display',
            settings: {
                contentWidth: { titleKey: 'settingsAppearance.contentWidth', descriptionKey: 'settingsAppearance.contentWidthDescription', storage: { scope: 'local', key: 'uiContentWidthMode', access: 'read_write' } },
                editorTabs: { titleKey: 'settingsAppearance.detailsPaneTabsBehavior', descriptionKey: 'settingsAppearance.detailsPaneTabsBehaviorDescription', storage: { scope: 'local', key: 'detailsPaneTabsBehavior', access: 'read_write' } },
                rightPanels: { titleKey: 'settingsAppearance.multiPanePanels', descriptionKey: 'settingsAppearance.multiPanePanelsDescription', storage: { scope: 'local', key: 'uiMultiPanePanelsEnabled', access: 'read_write' } },
                settingsSidebar: { titleKey: 'settingsAppearance.settingsNavSidebar', descriptionKey: 'settingsAppearance.settingsNavSidebarDescription', storage: { scope: 'local', key: 'settingsNavSidebarEnabled', access: 'read_write' } },
                navigationPlacements: { titleKey: 'navigationPlacement.title', descriptionKey: 'navigationPlacement.description', storage: navigationPlacementStorageBinding },
            },
        },
        home: {
            titleKey: 'settingsOverview.homeLayoutSectionTitle',
            settings: {
                homeSections: {
                    titleKey: 'settingsOverview.homeCustomize',
                    descriptionKey: 'settingsOverview.homeCustomizeDescription',
                },
            },
        },
        widgets: {
            titleKey: 'widgetFrame.appearanceTitle',
            settings: {
                widgetFrameHome: { titleKey: 'widgetFrame.surfaceHome', storage: { scope: 'local', key: 'widgetFrameStyleHome', access: 'read_write', allowedValues: ['card', 'plain'] } },
                widgetFrameBoard: { titleKey: 'widgetFrame.surfaceBoard', storage: { scope: 'local', key: 'widgetFrameStyleBoard', access: 'read_write', allowedValues: ['card', 'plain'] } },
                widgetFrameCompanion: { titleKey: 'widgetFrame.surfaceCompanion', storage: { scope: 'local', key: 'widgetFrameStyleCompanion', access: 'read_write', allowedValues: ['card', 'plain'] } },
            },
        },
        sessions: {
            titleKey: 'tabs.sessions',
            settings: {
                avatarStyle: { titleKey: 'settingsAppearance.avatarStyle', descriptionKey: 'settingsAppearance.avatarStyleDescription', storage: { scope: 'account', key: 'avatarStyle', access: 'read_write' } },
                agentIcons: { titleKey: 'settingsAppearance.showFlavorIcons', descriptionKey: 'settingsAppearance.showFlavorIconsDescription', storage: { scope: 'account', key: 'showFlavorIcons', access: 'read_write' } },
                alwaysShowContextSize: { titleKey: 'settingsAppearance.alwaysShowContextSize', descriptionKey: 'settingsAppearance.alwaysShowContextSizeDescription', storage: { scope: 'account', key: 'alwaysShowContextSize', access: 'read_write' } },
            },
        },
        tabBar: {
            titleKey: 'settingsAppearance.tabBarAppearance.title',
            settings: {
                tabBarSize: { titleKey: 'settingsAppearance.tabBarAppearance.size', storage: { scope: 'account', key: 'tabBarSize', access: 'read_write' } },
                tabBarLabels: { titleKey: 'settingsAppearance.tabBarAppearance.showLabels', storage: { scope: 'account', key: 'tabBarShowLabels', access: 'read_write' } },
                tabBarBadges: { titleKey: 'settingsAppearance.tabBarBadges.title' },
            },
        },
        loadingIndicator: {
            titleKey: 'settingsAppearance.loadingIndicator',
            settings: {
                loadingIndicatorStyle: { titleKey: 'settingsAppearance.loadingIndicatorStyle', descriptionKey: 'settingsAppearance.loadingIndicatorDescription', storage: { scope: 'local', key: 'loadingIndicatorStyle', access: 'read_write' } },
                loadingIndicatorSpeed: { titleKey: 'settingsAppearance.loadingIndicatorSpeed', descriptionKey: 'settingsAppearance.loadingIndicatorSpeedDescription', storage: { scope: 'local', key: 'loadingIndicatorSpeed', access: 'read_write' } },
                loadingIndicatorPause: { titleKey: 'settingsAppearance.loadingIndicatorPause', descriptionKey: 'settingsAppearance.loadingIndicatorPauseDescription', storage: { scope: 'local', key: 'loadingIndicatorPause', access: 'read_write' } },
            },
        },
        privacy: {
            titleKey: 'connectedServicesCollection.privacyTitle',
            settings: {
                hideAccountIdentities: {
                    titleKey: 'connectedServicesCollection.hideIdentitiesTitle',
                    descriptionKey: 'connectedServicesCollection.hideIdentitiesDescription',
                    storage: { scope: 'local', key: 'hideConnectedAccountIdentities', access: 'read_write' },
                },
            },
        },
        glass: {
            titleKey: 'settingsAppearance.glassControls.title',
            settings: {
                glassPreset: { titleKey: 'settingsAppearance.glassControls.material', storage: glassPresetStorageBinding },
                glassIntensity: { titleKey: 'settingsAppearance.glassControls.blur', storage: glassIntensityStorageBinding },
                glassCustomize: { titleKey: 'settingsAppearance.glassControls.customize' },
                glassChromeBlur: { titleKey: 'settingsAppearance.glassControls.chrome', descriptionKey: 'settingsAppearance.glassControls.blur', storage: glassSurfaceStorageBinding('chrome', 'blur') },
                glassChromeOpacity: { titleKey: 'settingsAppearance.glassControls.chrome', descriptionKey: 'settingsAppearance.glassControls.opacity', host: settingsHosts.web, storage: glassSurfaceStorageBinding('chrome', 'opacity') },
                glassSidebarBlur: { titleKey: 'settingsAppearance.glassControls.sidebar', descriptionKey: 'settingsAppearance.glassControls.blur', storage: glassSurfaceStorageBinding('sidebar', 'blur') },
                glassSidebarOpacity: { titleKey: 'settingsAppearance.glassControls.sidebar', descriptionKey: 'settingsAppearance.glassControls.opacity', host: settingsHosts.web, storage: glassSurfaceStorageBinding('sidebar', 'opacity') },
                glassContentBlur: { titleKey: 'settingsAppearance.glassControls.content', descriptionKey: 'settingsAppearance.glassControls.blur', storage: glassSurfaceStorageBinding('content', 'blur') },
                glassContentOpacity: { titleKey: 'settingsAppearance.glassControls.content', descriptionKey: 'settingsAppearance.glassControls.opacity', host: settingsHosts.web, storage: glassSurfaceStorageBinding('content', 'opacity') },
                glassFloatingBlur: { titleKey: 'settingsAppearance.glassControls.floating', descriptionKey: 'settingsAppearance.glassControls.blur', storage: glassSurfaceStorageBinding('floating', 'blur') },
                glassFloatingOpacity: { titleKey: 'settingsAppearance.glassControls.floating', descriptionKey: 'settingsAppearance.glassControls.opacity', host: settingsHosts.web, storage: glassSurfaceStorageBinding('floating', 'opacity') },
            },
        },
    },
});
