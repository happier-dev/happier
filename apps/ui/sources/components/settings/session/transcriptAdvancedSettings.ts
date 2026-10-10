import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of Transcript › Performance and timing (a sub-page linked from Transcript). */
export const TRANSCRIPT_ADVANCED_SETTINGS = defineSettingsPage({
    pageId: 'transcript',
    subpage: { id: 'advanced', route: SETTINGS_ROUTES.transcriptAdvanced, titleKey: 'settingsSessionPages.transcript.advancedTitle' },
    sections: {
        performance: {
            titleKey: 'settingsSession.transcript.advanced.performanceTitle',
            settings: {
                coalesceEnabled: {},
                coalesceWindow: {},
                coalesceMaxBatch: {},
                streamingPartialOutput: {},
                thinkingPulseStale: {},
            },
        },
        motion: {
            titleKey: 'settingsSession.transcript.motionTitle',
            settings: {
                freshness: {},
                animateNewItems: {},
                animateToolExpandCollapse: {},
                animateToolExpandCollapseFreshOnly: {},
                animateThinking: {},
            },
        },
        scroll: {
            titleKey: 'settingsSession.transcript.scrollTitle',
            settings: {
                pinOffset: {},
                autoFollow: {},
                jumpMinNewCount: {},
                jumpAnimateScroll: {},
            },
        },
    },
});
