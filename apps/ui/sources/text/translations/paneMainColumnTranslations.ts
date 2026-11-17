import type { SupportedLanguage } from '../_all';

export type MainColumnCopy = Readonly<{
    hideSession: string;
    showSession: string;
    hideProject: string;
    showProject: string;
    hideWorkflow: string;
    showWorkflow: string;
    hidePage: (params: { title: string }) => string;
    showPage: (params: { title: string }) => string;
    needsYou: string;
    chipA11y: (params: { label: string; name: string }) => string;
    chipNeedsYouA11y: (params: { label: string; name: string }) => string;
    chipNeedsYouAnnouncement: (params: { name: string }) => string;
    sidebarReleaseToHide: string;
    backToTranscript: string;
}>;

export const paneMainColumnTranslations = {
    en: { hideSession: 'Hide session', showSession: 'Show session', hideProject: 'Hide project', showProject: 'Show project', hideWorkflow: 'Hide workflow', showWorkflow: 'Show workflow', hidePage: ({ title }: { title: string }) => `Hide ${title}`, showPage: ({ title }: { title: string }) => `Show ${title}` , needsYou: 'Needs you', chipA11y: ({ label, name }: { label: string; name: string }) => `${label}: ${name}`, chipNeedsYouA11y: ({ label, name }: { label: string; name: string }) => `${label}: ${name}, needs you`, chipNeedsYouAnnouncement: ({ name }: { name: string }) => `${name} needs you`, sidebarReleaseToHide: 'Release to hide', backToTranscript: 'Back to transcript' },
} as const satisfies Pick<Record<SupportedLanguage, MainColumnCopy>, 'en'>;
