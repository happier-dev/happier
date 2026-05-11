import type { OnboardingShowcaseManifest } from './types';

function placeholderImageDataUri(startColor: string, endColor: string, accentColor: string): string {
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 880">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${startColor}"/>
      <stop offset="1" stop-color="${endColor}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="58%">
      <stop offset="0" stop-color="${accentColor}" stop-opacity="0.72"/>
      <stop offset="1" stop-color="${accentColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="880" height="880" rx="96" fill="url(#bg)"/>
  <circle cx="440" cy="372" r="300" fill="url(#glow)"/>
  <path d="M214 587c80-158 190-238 330-238 64 0 120 17 169 50" fill="none" stroke="rgba(255,255,255,0.58)" stroke-width="42" stroke-linecap="round"/>
  <path d="M248 649c75-91 168-137 279-137 46 0 89 8 129 25" fill="none" stroke="rgba(255,255,255,0.36)" stroke-width="30" stroke-linecap="round"/>
  <circle cx="298" cy="292" r="44" fill="rgba(255,255,255,0.74)"/>
  <circle cx="610" cy="272" r="28" fill="rgba(255,255,255,0.48)"/>
  <circle cx="660" cy="624" r="52" fill="rgba(255,255,255,0.24)"/>
</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const placeholderImages = {
    anywhere: placeholderImageDataUri('#101827', '#3545a3', '#78d5ff'),
    terminalTuis: placeholderImageDataUri('#111827', '#334155', '#a7f3d0'),
    cockpit: placeholderImageDataUri('#0f172a', '#1d4ed8', '#93c5fd'),
    existingSessions: placeholderImageDataUri('#1f2937', '#4b5563', '#fbbf24'),
    voiceAssistant: placeholderImageDataUri('#3b0764', '#7e22ce', '#f0abfc'),
    reviewComments: placeholderImageDataUri('#151515', '#4b5563', '#f3d36b'),
    subagents: placeholderImageDataUri('#172554', '#0f766e', '#67e8f9'),
    inbox: placeholderImageDataUri('#312e81', '#1e1b4b', '#c4b5fd'),
    mcp: placeholderImageDataUri('#06261f', '#1f7a54', '#a7f3d0'),
    queue: placeholderImageDataUri('#1b1b2f', '#4c1d95', '#f0abfc'),
    automations: placeholderImageDataUri('#422006', '#b45309', '#fde68a'),
    accounts: placeholderImageDataUri('#082f49', '#0369a1', '#bae6fd'),
    privacy: placeholderImageDataUri('#020617', '#334155', '#e5e7eb'),
    pets: placeholderImageDataUri('#3b1d2f', '#9f1239', '#fda4af'),
} as const;

type OnboardingImageKey = keyof typeof placeholderImages;

function imageCard(key: OnboardingImageKey, titleKey: string, bodyKey: string, altKey: string, wideTitleKey?: string) {
    return {
        kind: 'image' as const,
        titleKey,
        wideTitleKey,
        bodyKey,
        media: {
            key: `onboarding-showcase/${key}-placeholder.svg`,
            primaryUrl: placeholderImages[key],
            altKey,
        },
    };
}

/**
 * Bundled first-open onboarding showcase content.
 *
 * This is evergreen product onboarding, not per-release content. Placeholder media
 * intentionally stays local/data-URI-backed until final screenshots or videos are captured.
 */
export const ONBOARDING_SHOWCASE_MANIFEST: OnboardingShowcaseManifest = {
    schemaVersion: 'v1',
    showcaseVersion: 'v4',
    titleKey: 'releaseNotes.onboardingShowcase.title',
    subtitleKey: 'releaseNotes.onboardingShowcase.subtitle',
    cards: [
        {
            kind: 'list',
            titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.title',
            rows: [
                { iconId: 'sparkles', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.everywhereTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.everywhereBody' },
                { iconId: 'terminal', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.cockpitTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.cockpitBody' },
                { iconId: 'eye', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.existingTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.existingBody' },
                { iconId: 'wand', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.voiceTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.voiceBody' },
                { iconId: 'code', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.reviewTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.reviewBody' },
                { iconId: 'layers', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.subagentsTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.subagentsBody' },
                { iconId: 'terminal', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.tuisTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.tuisBody' },
                { iconId: 'bell', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.inboxTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.inboxBody' },
                { iconId: 'globe', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.mcpTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.mcpBody' },
                { iconId: 'refresh', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.controlTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.controlBody' },
                { iconId: 'time', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.automationsTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.automationsBody' },
                { iconId: 'user', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.accountsTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.accountsBody' },
                { iconId: 'bookmark', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.promptsTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.promptsBody' },
                { iconId: 'lock', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.privacyTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.privacyBody' },
                { iconId: 'heart', titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.petsTitle', bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.petsBody' },
            ],
        },
        imageCard('anywhere', 'releaseNotes.onboardingShowcase.cards.anywhere.title', 'releaseNotes.onboardingShowcase.cards.anywhere.body', 'releaseNotes.onboardingShowcase.cards.anywhere.alt', 'releaseNotes.onboardingShowcase.cards.anywhere.wideTitle'),
        imageCard('terminalTuis', 'releaseNotes.onboardingShowcase.cards.terminalTuis.title', 'releaseNotes.onboardingShowcase.cards.terminalTuis.body', 'releaseNotes.onboardingShowcase.cards.terminalTuis.alt', 'releaseNotes.onboardingShowcase.cards.terminalTuis.wideTitle'),
        imageCard('cockpit', 'releaseNotes.onboardingShowcase.cards.cockpit.title', 'releaseNotes.onboardingShowcase.cards.cockpit.body', 'releaseNotes.onboardingShowcase.cards.cockpit.alt', 'releaseNotes.onboardingShowcase.cards.cockpit.wideTitle'),
        imageCard('existingSessions', 'releaseNotes.onboardingShowcase.cards.existingSessions.title', 'releaseNotes.onboardingShowcase.cards.existingSessions.body', 'releaseNotes.onboardingShowcase.cards.existingSessions.alt'),
        imageCard('voiceAssistant', 'releaseNotes.onboardingShowcase.cards.voiceAssistant.title', 'releaseNotes.onboardingShowcase.cards.voiceAssistant.body', 'releaseNotes.onboardingShowcase.cards.voiceAssistant.alt', 'releaseNotes.onboardingShowcase.cards.voiceAssistant.wideTitle'),
        imageCard('reviewComments', 'releaseNotes.onboardingShowcase.cards.reviewComments.title', 'releaseNotes.onboardingShowcase.cards.reviewComments.body', 'releaseNotes.onboardingShowcase.cards.reviewComments.alt'),
        imageCard('subagents', 'releaseNotes.onboardingShowcase.cards.subagents.title', 'releaseNotes.onboardingShowcase.cards.subagents.body', 'releaseNotes.onboardingShowcase.cards.subagents.alt'),
        imageCard('inbox', 'releaseNotes.onboardingShowcase.cards.inbox.title', 'releaseNotes.onboardingShowcase.cards.inbox.body', 'releaseNotes.onboardingShowcase.cards.inbox.alt'),
        imageCard('mcp', 'releaseNotes.onboardingShowcase.cards.mcp.title', 'releaseNotes.onboardingShowcase.cards.mcp.body', 'releaseNotes.onboardingShowcase.cards.mcp.alt', 'releaseNotes.onboardingShowcase.cards.mcp.wideTitle'),
        imageCard('queue', 'releaseNotes.onboardingShowcase.cards.queue.title', 'releaseNotes.onboardingShowcase.cards.queue.body', 'releaseNotes.onboardingShowcase.cards.queue.alt'),
        imageCard('automations', 'releaseNotes.onboardingShowcase.cards.automations.title', 'releaseNotes.onboardingShowcase.cards.automations.body', 'releaseNotes.onboardingShowcase.cards.automations.alt'),
        imageCard('accounts', 'releaseNotes.onboardingShowcase.cards.accounts.title', 'releaseNotes.onboardingShowcase.cards.accounts.body', 'releaseNotes.onboardingShowcase.cards.accounts.alt'),
        imageCard('privacy', 'releaseNotes.onboardingShowcase.cards.privacy.title', 'releaseNotes.onboardingShowcase.cards.privacy.body', 'releaseNotes.onboardingShowcase.cards.privacy.alt', 'releaseNotes.onboardingShowcase.cards.privacy.wideTitle'),
        imageCard('pets', 'releaseNotes.onboardingShowcase.cards.pets.title', 'releaseNotes.onboardingShowcase.cards.pets.body', 'releaseNotes.onboardingShowcase.cards.pets.alt', 'releaseNotes.onboardingShowcase.cards.pets.wideTitle'),
    ],
};
