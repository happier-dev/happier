import type { ReviewListItemV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { t } from '@/text';

export function reviewStateLabel(state: ReviewListItemV1['state']): string {
    switch (state) {
        case 'running':
            return t('reviewWalkthrough.collection.stateRunning');
        case 'partial':
            return t('reviewWalkthrough.collection.statePartial');
        case 'failed':
            return t('reviewWalkthrough.collection.stateFailed');
        case 'cancelled':
            return t('reviewWalkthrough.collection.stateCancelled');
        case 'completed':
            return t('reviewWalkthrough.collection.stateCompleted');
    }
}
