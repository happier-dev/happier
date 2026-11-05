import { defineSettingsPage, settingsHosts, type SettingsSubpageDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { themeModeStorageBinding } from './themeModeSettingBinding';
import { resetAppearanceSettings } from './appearanceDefaults';
import { glassIntensityStorageBinding, glassPresetStorageBinding, glassSurfaceStorageBinding, glassTintStorageBinding } from './glassSettingBindings';
import { invokeNavigationPlacementCustomizer, navigationPlacementStorageBinding } from './navigationPlacementSettingBinding';
import { surfaceFinishOverrideStorageBinding } from './surfaceFinishSettingBindings';
import { machineSummaryMetricsStorageBinding } from '@/components/machines/summary/machineSummarySettingBindings';
import { atmosphereFieldStorageBinding, homeAtmosphereStorageBinding, invokeAtmospherePictureOperation } from '@/components/atmosphere/atmosphereSettings';

/**
 * A page reached from Appearance that holds rows which used to sit on Appearance itself. They keep
 * their `appearance.<settingId>` ids, so search, links and Actions resolve as before.
 */
const movedRows = (id: string, route: string, titleKey: SettingsSubpageDeclaration['titleKey']): SettingsSubpageDeclaration => (
    { id, route, titleKey, anchors: 'page' }
);

/** The Appearance page itself: theme, text and density, layout, sessions. */
export const APPEARANCE_PAGE_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    sections: {
        personalize: {
            settings: {
                reset: { operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
                    invoke: resetAppearanceSettings } },
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
        text: {
            titleKey: 'settingsAppearance.text',
            settings: {
                textSize: {},
                density: {},
            },
        },
        chatCodeBlocks: {
            titleKey: 'settingsAppearance.chatCodeBlocks.title',
            settings: {
                showChatCodeBlockWrapControls: {},
                wrapChatCodeBlocks: {},
            },
        },
        display: {
            titleKey: 'settingsAppearance.display',
            settings: {
                contentWidth: {},
                editorTabs: {},
                rightPanels: {},
                paneArrangement: {},
                rightPanelPlacement: {},
                settingsSidebar: {},
                navigationPlacements: { storage: navigationPlacementStorageBinding,
                    operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
                        invoke: invokeNavigationPlacementCustomizer } },
            },
        },
        home: {
            titleKey: 'settingsOverview.homeLayoutSectionTitle',
            settings: {
                homeSections: {},
            },
        },
        sessions: {
            titleKey: 'tabs.sessions',
            settings: {
                avatarStyle: {},
                agentIcons: {},
                alwaysShowContextSize: {},
                contextGaugeStyle: {},
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
        privacy: {
            titleKey: 'connectedServicesCollection.privacyTitle',
            settings: {
                hideAccountIdentities: {},
            },
        },
    },
});

/** Appearance › Glass and backdrop. */
export const APPEARANCE_GLASS_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    subpage: movedRows('glass', SETTINGS_ROUTES.appearanceGlass, 'settingsAppearance.glassControls.sectionTitle'),
    sections: {
        glass: {
            titleKey: 'settingsAppearance.glassControls.sectionTitle',
            settings: {
                glassPreset: { storage: glassPresetStorageBinding },
                homeAtmosphere: { storage: homeAtmosphereStorageBinding('appearance.homeAtmosphere') },
                atmosphereSource: { storage: atmosphereFieldStorageBinding('appearance.atmosphereSource') },
                atmospherePlanetPlacement: { storage: atmosphereFieldStorageBinding('appearance.atmospherePlanetPlacement') },
                atmospherePlanetStyle: { storage: atmosphereFieldStorageBinding('appearance.atmospherePlanetStyle') },
                atmospherePlanetDigits: { storage: atmosphereFieldStorageBinding('appearance.atmospherePlanetDigits') },
                atmospherePictureRef: { storage: atmosphereFieldStorageBinding('appearance.atmospherePictureRef') },
                atmospherePictureLayout: { storage: atmosphereFieldStorageBinding('appearance.atmospherePictureLayout') },
                atmosphereLooks: { storage: homeAtmosphereStorageBinding('appearance.atmosphereLooks') },
                atmosphereShowOn: { storage: atmosphereFieldStorageBinding('appearance.atmosphereShowOn') },
                projectAtmosphere: {},
                atmospherePictureLibrary: {},
                atmospherePictureAdd: { operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
                    invoke: context => invokeAtmospherePictureOperation('add', context) } },
                atmospherePictureRemove: { operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: true,
                    invoke: context => invokeAtmospherePictureOperation('remove', context) } },
                glassIntensity: { storage: glassIntensityStorageBinding },
                glassTint: { storage: glassTintStorageBinding },
                glassWindow: { host: settingsHosts.desktop, storage: glassSurfaceStorageBinding('content', 'mode') },
                glassChrome: { storage: glassSurfaceStorageBinding('chrome', 'mode') },
                glassSidebar: { storage: glassSurfaceStorageBinding('sidebar', 'mode') },
                glassElements: { storage: glassSurfaceStorageBinding('card', 'mode') },
                glassFloating: { storage: glassSurfaceStorageBinding('floating', 'mode') },
            },
        },
    },
});

/** Appearance › Moments: the atmosphere's one-shots, declared in the glass section they belong to. */
export const APPEARANCE_MOMENTS_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    subpage: movedRows('moments', SETTINGS_ROUTES.appearanceMoments, 'settingsAppearance.glassControls.moments'),
    sections: {
        glass: {
            titleKey: 'settingsAppearance.glassControls.sectionTitle',
            settings: {
                atmosphereMoments: { storage: atmosphereFieldStorageBinding('appearance.atmosphereMoments') },
            },
        },
    },
});

/** Appearance › Widgets and surfaces. */
export const APPEARANCE_WIDGETS_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    subpage: movedRows('widgets', SETTINGS_ROUTES.appearanceWidgets, 'settingsAppearance.widgetsAndSurfaces'),
    sections: {
        widgets: {
            titleKey: 'widgetFrame.appearanceTitle',
            settings: {
                widgetFrameHome: {},
                widgetFrameBoard: {},
                widgetFrameCompanion: {},
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
    },
});

/** Appearance › Motion. */
export const APPEARANCE_MOTION_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    subpage: movedRows('motion', SETTINGS_ROUTES.appearanceMotion, 'settingsAppearance.visualEffects.title'),
    sections: {
        visualEffects: { settings: { visualEffectsLevel: {}, animatedNumbers: {} } },
        feedback: {
            titleKey: 'settingsAppearance.feedback',
            host: settingsHosts.native,
            settings: { haptics: {} },
        },
        loadingIndicator: {
            titleKey: 'settingsAppearance.loadingIndicator',
            settings: {
                loadingIndicatorStyle: {},
                loadingIndicatorSpeed: {},
                loadingIndicatorPause: {},
            },
        },
    },
});

/** The Machine summary's look is set where machines are configured: Machines › Defaults. */
export const APPEARANCE_MACHINE_SUMMARY_SETTINGS = defineSettingsPage({
    pageId: 'appearance',
    subpage: movedRows('machineSummary', SETTINGS_ROUTES.machineDefaults, 'settings.machines'),
    sections: {
        machineSummary: {
            titleKey: 'machineSummary.settingTitle',
            settings: {
                machineSummaryStyle: {},
                machineSummaryMetrics: { storage: machineSummaryMetricsStorageBinding },
            },
        },
    },
});

/**
 * Appearance's searchable settings, wherever their rows render. Rows take their labels and anchors
 * from these declarations; the glass section answers for the Glass and backdrop page.
 */
export const APPEARANCE_SETTINGS = {
    settings: {
        ...APPEARANCE_PAGE_SETTINGS.settings,
        ...APPEARANCE_GLASS_SETTINGS.settings,
        ...APPEARANCE_MOMENTS_SETTINGS.settings,
        ...APPEARANCE_WIDGETS_SETTINGS.settings,
        ...APPEARANCE_MOTION_SETTINGS.settings,
        ...APPEARANCE_MACHINE_SUMMARY_SETTINGS.settings,
    },
    sectionRefs: {
        ...APPEARANCE_PAGE_SETTINGS.sectionRefs,
        ...APPEARANCE_MOMENTS_SETTINGS.sectionRefs,
        ...APPEARANCE_GLASS_SETTINGS.sectionRefs,
        ...APPEARANCE_WIDGETS_SETTINGS.sectionRefs,
        ...APPEARANCE_MOTION_SETTINGS.sectionRefs,
        ...APPEARANCE_MACHINE_SUMMARY_SETTINGS.sectionRefs,
    },
} as const;
