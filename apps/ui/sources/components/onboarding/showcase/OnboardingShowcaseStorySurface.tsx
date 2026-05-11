import * as React from 'react';

import { StorySheetFrame, StoryDeckSurface } from '@/components/ui/storyDeck';
import type { OnboardingShowcaseManifest } from '@/onboarding/showcase';

export type OnboardingShowcaseStorySurfaceProps = Readonly<{
    manifest: OnboardingShowcaseManifest;
    onComplete: () => void;
    onDismiss?: () => void;
    testID?: string;
}>;

export function OnboardingShowcaseStorySurface(props: OnboardingShowcaseStorySurfaceProps) {
    return (
        <StorySheetFrame testID={props.testID ?? 'onboarding-showcase-story'} onDismiss={props.onDismiss}>
            <StoryDeckSurface
                cards={props.manifest.cards}
                onComplete={props.onComplete}
                onDismiss={props.onDismiss}
                slideAnimation="softBlur"
                testID="onboarding-showcase"
            />
        </StorySheetFrame>
    );
}
