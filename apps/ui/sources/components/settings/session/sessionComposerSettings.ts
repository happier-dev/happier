import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage, settingsHosts } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of Sessions › Composer (a sub-page linked from Sessions). */
export const SESSION_COMPOSER_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'composer', route: SETTINGS_ROUTES.sessionComposer, titleKey: 'settingsSession.composer.title' },
    sections: {
        newSessions: {
            titleKey: 'settingsSessionPages.composer.newSessionsSection',
            settings: {
                draftEntry: { storage: { scope: 'account', key: 'newSessionDraftEntryMode', access: 'read_write' },
                    titleKey: 'settingsSessionPages.composer.draftEntryTitle',
                    keywordKeys: ['settingsSession.newSessionDraftEntry.title'],
                },
                presentation: { storage: { scope: 'account', key: 'newSessionPresentationModeV1', access: 'read_write' },
                    titleKey: 'settingsSession.sessionCreation.presentationModeTitle',
                    keywordKeys: ['settingsSession.sessionCreation.presentationModalTitle'],
                },
            },
        },
        typing: {
            titleKey: 'settingsSessionPages.composer.typingSection',
            settings: {
                enterToSend: { titleKey: 'settingsSessionPages.composer.enterToSendTitle' },
                historyScope: { storage: { scope: 'account', key: 'agentInputHistoryScope', access: 'read_write' }, titleKey: 'settingsFeatures.historyScope', host: settingsHosts.web },
            },
        },
        sending: {
            titleKey: 'settingsSession.messageSending.title',
            settings: {
                sendMode: { storage: { scope: 'account', key: 'sessionMessageSendMode', access: 'read_write' },
                    titleKey: 'settingsSessionPages.composer.sendModeTitle',
                    keywordKeys: ['settingsSessionPages.composer.sendQueue', 'settingsSessionPages.composer.sendInterrupt'],
                },
                busySteer: { storage: { scope: 'account', key: 'sessionBusySteerSendPolicy', access: 'read_write' }, titleKey: 'settingsSessionPages.composer.busySteerTitle' },
                nonSteerablePrompt: { storage: { scope: 'account', key: 'sessionNonSteerableSendPrompt', access: 'read_write' }, titleKey: 'settingsSessionPages.composer.nonSteerableTitle' },
                inactiveResume: { storage: { scope: 'account', key: 'sessionInactiveResumePolicy', access: 'read_write' }, titleKey: 'settingsSession.messageSending.inactiveResumePolicyTitle' },
            },
        },
        pendingQueue: {
            titleKey: 'settingsSessionPages.composer.pendingSection',
            settings: {
                pendingDrain: { storage: { scope: 'account', key: 'sessionPendingQueueDrainMode', access: 'read_write' }, titleKey: 'settingsSession.messageSending.pendingDrainModeTitle' },
                pendingTiming: { storage: { scope: 'account', key: 'sessionPendingQueueDeliveryTiming', access: 'read_write' }, titleKey: 'settingsSession.messageSending.pendingDeliveryTimingTitle' },
            },
        },
        layout: {
            titleKey: 'settingsSessionPages.composer.layoutSection',
            settings: {
                promptLibraryButton: { storage: { scope: 'account', key: 'composerPromptLibraryButtonEnabled', access: 'read_write' }, titleKey: 'committedMessageActions.composerButton', descriptionKey: 'committedMessageActions.composerHint' },
                actionBar: { storage: { scope: 'account', key: 'agentInputActionBarLayout', access: 'read_write' }, titleKey: 'settingsSessionPages.composer.actionBarTitle' },
                chipDensity: { storage: { scope: 'account', key: 'agentInputChipDensity', access: 'read_write' }, titleKey: 'settingsSessionPages.composer.chipDensityTitle' },
                glass: { storage: { scope: 'account', key: 'composerSurfaceStyle', access: 'read_write' }, titleKey: 'settingsAppearance.glass.composer', descriptionKey: 'settingsAppearance.glass.composerHint' },
            },
        },
        banners: {
            titleKey: 'settingsSession.banners.title',
            settings: {
                rememberBanners: { storage: { scope: 'account', key: 'sessionComposerRememberBannerVisibility', access: 'read_write' }, titleKey: 'settingsSession.banners.rememberVisibilityTitle', descriptionKey: 'settingsSession.banners.rememberVisibilitySubtitle' },
            },
        },
    },
});
