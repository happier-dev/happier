import * as React from 'react';

import { relayAccessProviderDescriptors, type RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { RelayAccessControlOptions } from '@/components/settings/server/relayAccess/useRelayAccessControl';

import { RelayAccessConfigFieldsStep } from './RelayAccessConfigFieldsStep';
import { relayAccessConfigStepCatalog } from './relayAccessConfigStepCatalog';
import { RelayAccessTailscalePrerequisitesStep } from './RelayAccessTailscalePrerequisitesStep';
import type { RelayAccessWizardPrimaryState } from './useRelayAccessWizardConfigStep';

export type RelayAccessPrerequisitesStepProps = Readonly<{
    testID?: string;
    providerId: RelayAccessProviderId | null;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    runWithTarget?: RelayAccessControlOptions['runWithTarget'];
    remoteHost?: RelayAccessControlOptions['remoteHost'];
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: RelayAccessWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>;

/** The provider's descriptor decides its details step: the Tailscale setup task, or its declared config fields. */
export const RelayAccessPrerequisitesStep = React.memo(function RelayAccessPrerequisitesStep(
    props: RelayAccessPrerequisitesStepProps,
) {
    const descriptor = relayAccessProviderDescriptors.find((candidate) => candidate.id === props.providerId);
    if (!descriptor) {
        return null;
    }
    if (descriptor.homeSetupTaskKind === 'secureAccess.tailscale.v1') {
        return <RelayAccessTailscalePrerequisitesStep key={descriptor.id} {...props} providerId={descriptor.id} />;
    }
    const definition = relayAccessConfigStepCatalog[descriptor.id];
    return definition ? <RelayAccessConfigFieldsStep key={descriptor.id} {...props} definition={definition} /> : null;
});
