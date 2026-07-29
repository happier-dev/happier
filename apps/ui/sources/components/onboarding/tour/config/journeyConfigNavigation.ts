import { t } from '@/text';

import type { JourneyProgressController } from '../state/useJourneyProgress';

import type { JourneyConfigControllerSurface } from './JourneyConfigSlot';

export function withPersistentJourneySkip(
    controller: JourneyConfigControllerSurface,
    progress: Pick<JourneyProgressController, 'showSkipToSetup' | 'skipToSetup'>,
): JourneyConfigControllerSurface {
    if (!progress.showSkipToSetup) {
        return controller;
    }

    return {
        ...controller,
        onSkip: progress.skipToSetup,
        skipLabel: t('journey.actions.skipToSetup'),
        skipDisabled: false,
        showSkip: true,
    };
}
