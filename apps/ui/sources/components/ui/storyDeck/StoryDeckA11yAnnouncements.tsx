import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

import { t, tLoose } from '@/text';

export type StoryDeckA11yAnnouncementsProps = Readonly<{
    currentIndex: number;
    totalCount: number;
    currentTitleKey: string;
}>;

/**
 * Headless announcer that emits an a11y live-region update whenever the active
 * slide changes. Native uses `AccessibilityInfo.announceForAccessibility`; web
 * uses a hidden polite live-region in the DOM.
 */
export function StoryDeckA11yAnnouncements(props: StoryDeckA11yAnnouncementsProps) {
    const { currentIndex, totalCount, currentTitleKey } = props;

    React.useEffect(() => {
        const title = tLoose(currentTitleKey);
        const message = totalCount > 1
            ? t('releaseNotes.storyDeck.slideAnnouncement', {
                title,
                current: currentIndex + 1,
                total: totalCount,
            })
            : title;

        if (Platform.OS === 'web') {
            const doc = (globalThis as { document?: Document }).document;
            if (!doc?.body) return;
            const liveRegion = ensureWebLiveRegion(doc);
            liveRegion.textContent = '';
            // small async to force AT to pick up the change
            const timer = setTimeout(() => { liveRegion.textContent = message; }, 30);
            return () => clearTimeout(timer);
        }

        try {
            AccessibilityInfo.announceForAccessibility(message);
        } catch {
            // ignore
        }
    }, [currentIndex, totalCount, currentTitleKey]);

    return null;
}

function ensureWebLiveRegion(doc: Document): HTMLElement {
    const existing = doc.querySelector<HTMLElement>('[data-story-deck-live-region="true"]');
    if (existing) return existing;
    const region = doc.createElement('div');
    region.setAttribute('data-story-deck-live-region', 'true');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    region.style.position = 'absolute';
    region.style.left = '-10000px';
    region.style.width = '1px';
    region.style.height = '1px';
    region.style.overflow = 'hidden';
    doc.body.appendChild(region);
    return region;
}
