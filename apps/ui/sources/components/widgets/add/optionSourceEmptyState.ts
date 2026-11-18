import type { InputFieldHint } from '@happier-dev/protocol/inputs/inputFields';
import { SAVED_HEALTH_CHECKS_OPTIONS_SOURCE_ID_V1 } from '@happier-dev/protocol/inputs/savedHealthCheckOptions';

import { SERVICES_ROUTE } from '@/components/projects/deployments/deploymentNavigation';
import { t } from '@/text';

export type OptionSourceEmptyState = Readonly<{
    message: string;
    /** Where the person makes the first choice exist; only a source whose prerequisite has a place names one. */
    action?: Readonly<{ label: string; href: string }>;
}>;

/**
 * Whether an input's own source settled with nothing to offer while nothing is chosen. Its setup row then says so in
 * words; the step's preview and footer read this same decision and leave the fact to the row (said once).
 */
export function isNothingToChoose(input: Readonly<{
    field: Pick<InputFieldHint, 'widget' | 'optionsSourceId' | 'inputType' | 'allowCustomValue'>;
    optionsStatus: 'loading' | 'ready' | 'failed';
    optionCount: number;
    value: unknown;
    follows: boolean;
}>): boolean {
    const { field } = input;
    return (field.widget === 'select' || field.widget === 'multiselect') && field.optionsSourceId !== undefined
        && field.inputType === undefined && field.allowCustomValue !== true && input.optionsStatus === 'ready'
        && input.optionCount === 0 && input.value === undefined && !input.follows;
}

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
