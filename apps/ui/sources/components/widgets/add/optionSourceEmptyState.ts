import { SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1 } from '@happier-dev/protocol/inputs/savedHealthCheckOptions';

import { SERVICES_ROUTE } from '@/components/projects/deployments/deploymentNavigation';
import { t } from '@/text';

export type OptionSourceEmptyState = Readonly<{
    message: string;
    /** Where the person makes the first choice exist; only a source whose prerequisite has a place names one. */
    action?: Readonly<{ label: string; href: string }>;
}>;

/**
 * What an input says when its option source has nothing to offer yet (patterns.md prerequisites: never a form that
 * cannot succeed). Every source says there is nothing to choose; a host source whose choices are made elsewhere names
 * that place: saved Checks are added from an app's Checks and alerts in Services (the Monitoring empty scene's step).
 */
export function readOptionSourceEmptyState(optionsSourceId: string | undefined): OptionSourceEmptyState {
    if (optionsSourceId === SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1) {
        return { message: t('projects.deployments.monitoring.widgetNoChecks'),
            action: { label: t('projects.deployments.monitoring.openServices'), href: SERVICES_ROUTE } };
    }
    return { message: t('widgetAdd.noChoices') };
}
