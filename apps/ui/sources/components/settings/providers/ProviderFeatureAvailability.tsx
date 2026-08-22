import * as React from 'react';
import type { FeatureDecision } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    resolveFeatureAvailabilityArm,
    type FeatureAvailabilityArm,
} from '@/hooks/server/resolveFeatureAvailabilityArm';
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

const PRESENTATION_BY_ARM: Record<
    Exclude<FeatureAvailabilityArm, 'available'>,
    ProviderAvailabilityPresentation
> = {
    checking: {
        titleKey: 'settingsProviders.availabilityChecking',
        descriptionKey: 'settingsProviders.availabilityCheckingDescription',
    },
    unknown: {
        titleKey: 'settingsProviders.availabilityProblem',
        descriptionKey: 'settingsProviders.availabilityProblemDescription',
    },
    unsupported_context: {
        titleKey: 'settingsProviders.availabilityContextUnsupported',
        descriptionKey: 'settingsProviders.availabilityContextUnsupportedDescription',
    },
    unsupported: {
        titleKey: 'settingsProviders.availabilityUnsupported',
        descriptionKey: 'settingsProviders.availabilityUnsupportedDescription',
    },
    server_disabled: {
        titleKey: 'settingsProviders.unavailable',
        descriptionKey: 'settingsProviders.unavailableDescription',
    },
    policy_disabled: {
        titleKey: 'settingsProviders.availabilityPolicyDisabled',
        descriptionKey: 'settingsProviders.availabilityPolicyDisabledDescription',
    },
};

export function resolveProviderAvailabilityPresentation(
    decision: FeatureDecision | null,
): ProviderAvailabilityPresentation | null {
    const arm = resolveFeatureAvailabilityArm(decision);
    return arm === 'available' ? null : PRESENTATION_BY_ARM[arm];
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
