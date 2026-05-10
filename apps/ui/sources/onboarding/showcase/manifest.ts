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
    cockpit: placeholderImageDataUri('#101827', '#3545a3', '#78d5ff'),
    reviewComments: placeholderImageDataUri('#151515', '#4b5563', '#f3d36b'),
    sourceControl: placeholderImageDataUri('#06261f', '#1f7a54', '#a7f3d0'),
    markdown: placeholderImageDataUri('#1b1b2f', '#4c1d95', '#f0abfc'),
    media: placeholderImageDataUri('#172554', '#0e7490', '#bfdbfe'),
    desktop: placeholderImageDataUri('#1f2937', '#64748b', '#e5e7eb'),
    pets: placeholderImageDataUri('#3b1d2f', '#9f1239', '#fda4af'),
} as const;

/**
 * Bundled onboarding showcase content.
 *
 * Authored locally (not from happier-assets), because onboarding content evolves with
 * the app and ships as part of the binary. Media assets still come from happier-assets
 * via the same asset resolver to avoid bundle bloat.
 */
export const ONBOARDING_SHOWCASE_MANIFEST: OnboardingShowcaseManifest = {
    schemaVersion: 'v1',
    showcaseVersion: 'v3',
    titleKey: 'releaseNotes.onboardingShowcase.title',
    subtitleKey: 'releaseNotes.onboardingShowcase.subtitle',
    cards: [
        {
            kind: 'list',
            titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.title',
            rows: [
                {
                    iconId: 'sparkles',
                    titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.row1Title',
                    bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.row1Body',
                },
                {
                    iconId: 'rocket',
                    titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.row2Title',
                    bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.row2Body',
                },
                {
                    iconId: 'shield',
                    titleKey: 'releaseNotes.onboardingShowcase.cards.welcome.row3Title',
                    bodyKey: 'releaseNotes.onboardingShowcase.cards.welcome.row3Body',
                },
            ],
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.cockpit.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.cockpit.body',
            media: {
                key: 'onboarding-showcase/cockpit-placeholder.svg',
                primaryUrl: placeholderImages.cockpit,
                altKey: 'releaseNotes.onboardingShowcase.cards.cockpit.alt',
            },
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.reviewComments.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.reviewComments.body',
            media: {
                key: 'onboarding-showcase/review-comments-placeholder.svg',
                primaryUrl: placeholderImages.reviewComments,
                altKey: 'releaseNotes.onboardingShowcase.cards.reviewComments.alt',
            },
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.sourceControl.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.sourceControl.body',
            media: {
                key: 'onboarding-showcase/source-control-placeholder.svg',
                primaryUrl: placeholderImages.sourceControl,
                altKey: 'releaseNotes.onboardingShowcase.cards.sourceControl.alt',
            },
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.markdown.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.markdown.body',
            media: {
                key: 'onboarding-showcase/markdown-placeholder.svg',
                primaryUrl: placeholderImages.markdown,
                altKey: 'releaseNotes.onboardingShowcase.cards.markdown.alt',
            },
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.media.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.media.body',
            media: {
                key: 'onboarding-showcase/media-placeholder.svg',
                primaryUrl: placeholderImages.media,
                altKey: 'releaseNotes.onboardingShowcase.cards.media.alt',
            },
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.desktop.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.desktop.body',
            media: {
                key: 'onboarding-showcase/desktop-placeholder.svg',
                primaryUrl: placeholderImages.desktop,
                altKey: 'releaseNotes.onboardingShowcase.cards.desktop.alt',
            },
        },
        {
            kind: 'image',
            titleKey: 'releaseNotes.onboardingShowcase.cards.pets.title',
            bodyKey: 'releaseNotes.onboardingShowcase.cards.pets.body',
            media: {
                key: 'onboarding-showcase/pets-placeholder.svg',
                primaryUrl: placeholderImages.pets,
                altKey: 'releaseNotes.onboardingShowcase.cards.pets.alt',
            },
        },
    ],
};
