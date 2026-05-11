import * as React from 'react';

import { StorySheetFrame, StoryDeckSurface } from '@/components/ui/storyDeck';
import type { ReleaseNotesRelease } from '@/changelog/releaseNotes';
import { t } from '@/text';

export type ReleaseNotesStorySurfaceProps = Readonly<{
    release: ReleaseNotesRelease;
    onComplete: () => void;
    onDismiss?: () => void;
    onViewFullChangelog?: () => void;
    testID?: string;
}>;

export function ReleaseNotesStorySurface(props: ReleaseNotesStorySurfaceProps) {
    const showSecondary = props.release.actions?.viewFullReleaseNotes !== false;

    return (
        <StorySheetFrame testID={props.testID ?? 'release-notes-story'} onDismiss={props.onDismiss}>
            <StoryDeckSurface
                cards={props.release.cards}
                onComplete={props.onComplete}
                onDismiss={props.onDismiss}
                onSecondaryAction={showSecondary ? props.onViewFullChangelog : undefined}
                secondaryActionLabel={t('releaseNotes.viewFullChangelog')}
                slideAnimation="softBlur"
                testID="release-notes"
            />
        </StorySheetFrame>
    );
}
