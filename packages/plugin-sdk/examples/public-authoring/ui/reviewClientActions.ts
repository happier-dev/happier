import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';

const REVIEW_SESSION_STATUS_VIEW_ID = 'review-session-status-details';

export const openReviewStatus: PluginClientActionHandler = async (_input, context) => {
    await context.ui.openSurface(
        REVIEW_SESSION_STATUS_VIEW_ID,
        undefined,
        { signal: context.signal },
    );
};

/** One platform-neutral client entry for the declared review-status Action. */
export function activate(api: PluginClientApi): void {
    api.actions.register('open-review-status', openReviewStatus);
}
