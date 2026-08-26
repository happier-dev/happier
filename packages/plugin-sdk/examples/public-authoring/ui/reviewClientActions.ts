import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiContextEnrichmentV1 } from '@happier-dev/plugin-sdk/ui';

const REVIEW_SESSION_STATUS_VIEW_ID = 'review-session-status-details';

/** Declarative enrichment only; the mounted host retains currentness and command authority. */
export const PROJECT_COMPANION_ACTIVITY_CURRENT_UI_CONTEXT = {
    entity: {
        kind: 'review',
        label: 'Project Companion activity',
        summary: 'Review guidance and status are available for this Session.',
    },
    detail: { source: 'public-authoring-project-companion-activity' },
    commands: [{
        title: 'Open review status',
        description: 'Open the existing review-status destination on this client.',
        command: {
            kind: 'executeAction',
            action: 'open-review-status',
        },
    }],
} as const satisfies PluginUiContextEnrichmentV1;

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
