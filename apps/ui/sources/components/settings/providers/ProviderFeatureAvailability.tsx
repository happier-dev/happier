import * as React from 'react';
import type { FeatureDecision } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { t } from '@/text';

export type ProviderAvailabilityPresentation = Readonly<{
    titleKey:
        | 'settingsProviders.availabilityChecking'
        | 'settingsProviders.availabilityProblem'
        | 'settingsProviders.availabilityUnsupported'
        | 'settingsProviders.availabilityContextUnsupported'
        | 'settingsProviders.availabilityPolicyDisabled'
        | 'settingsProviders.unavailable';
    descriptionKey:
        | 'settingsProviders.availabilityCheckingDescription'
        | 'settingsProviders.availabilityProblemDescription'
        | 'settingsProviders.availabilityUnsupportedDescription'
        | 'settingsProviders.availabilityContextUnsupportedDescription'
        | 'settingsProviders.availabilityPolicyDisabledDescription'
        | 'settingsProviders.unavailableDescription';
}>;

export function resolveProviderAvailabilityPresentation(
    decision: FeatureDecision | null,
): ProviderAvailabilityPresentation | null {
    if (!decision) {
        return {
            titleKey: 'settingsProviders.availabilityChecking',
            descriptionKey: 'settingsProviders.availabilityCheckingDescription',
        };
    }
    if (decision.state === 'enabled') return null;
    if (decision.state === 'unknown') {
        return {
            titleKey: 'settingsProviders.availabilityProblem',
            descriptionKey: 'settingsProviders.availabilityProblemDescription',
        };
    }
    if (decision.state === 'unsupported') {
        if (decision.blockedBy !== 'server' || decision.blockerCode !== 'endpoint_missing') {
            return {
                titleKey: 'settingsProviders.availabilityContextUnsupported',
                descriptionKey: 'settingsProviders.availabilityContextUnsupportedDescription',
            };
        }
        return {
            titleKey: 'settingsProviders.availabilityUnsupported',
            descriptionKey: 'settingsProviders.availabilityUnsupportedDescription',
        };
    }
    if (decision.blockedBy === 'server') {
        return {
            titleKey: 'settingsProviders.unavailable',
            descriptionKey: 'settingsProviders.unavailableDescription',
        };
    }
    return {
        titleKey: 'settingsProviders.availabilityPolicyDisabled',
        descriptionKey: 'settingsProviders.availabilityPolicyDisabledDescription',
    };
}

export function useProviderFeatureAvailability(): Readonly<{
    enabled: boolean;
    presentation: ProviderAvailabilityPresentation | null;
}> {
    const decision = useFeatureDecision('providers');
    const presentation = resolveProviderAvailabilityPresentation(decision);
    return { enabled: presentation === null, presentation };
}

export function ProviderFeatureAvailabilityNotice(
    props: Readonly<{ presentation: ProviderAvailabilityPresentation }>,
): React.ReactElement {
    return (
        <Item
            mode="info"
            title={t(props.presentation.titleKey)}
            subtitle={t(props.presentation.descriptionKey)}
        />
    );
}
