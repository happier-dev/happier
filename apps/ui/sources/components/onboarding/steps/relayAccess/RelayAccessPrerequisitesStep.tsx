import * as React from 'react';

import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { RelayAccessCloudflareNamedTunnelStep } from './RelayAccessCloudflareNamedTunnelStep';
import { RelayAccessLanUrlStep } from './RelayAccessLanUrlStep';
import { RelayAccessTailscalePrerequisitesStep } from './RelayAccessTailscalePrerequisitesStep';
import type { RelayAccessWizardPrimaryState } from './useRelayAccessWizardConfigStep';

export type RelayAccessPrerequisitesStepProps = Readonly<{
    testID?: string;
    providerId: RelayAccessProviderId | null;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: RelayAccessWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>;

type RelayAccessPrerequisiteStepComponent = React.ComponentType<Readonly<{
    testID?: string;
    providerId?: RelayAccessProviderId | null;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: RelayAccessWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>>;

const RelayAccessTailscaleRegistryStep: RelayAccessPrerequisiteStepComponent = React.memo(function RelayAccessTailscaleRegistryStep(props) {
    if (props.providerId !== 'tailscaleServe' && props.providerId !== 'tailscaleFunnel') {
        return null;
    }

    return (
        <RelayAccessTailscalePrerequisitesStep
            testID={props.testID}
            providerId={props.providerId}
            upstreamUrl={props.upstreamUrl}
            serverProfileId={props.serverProfileId}
            target={props.target}
            onShareUrlChange={props.onShareUrlChange}
            onWizardPrimaryChange={props.onWizardPrimaryChange}
            onRequestAdvance={props.onRequestAdvance}
        />
    );
});

const relayAccessPrerequisiteStepRegistry: Readonly<Partial<Record<RelayAccessProviderId, RelayAccessPrerequisiteStepComponent>>> = {
    lan: RelayAccessLanUrlStep,
    cloudflareNamed: RelayAccessCloudflareNamedTunnelStep,
    tailscaleServe: RelayAccessTailscaleRegistryStep,
    tailscaleFunnel: RelayAccessTailscaleRegistryStep,
};

export const RelayAccessPrerequisitesStep = React.memo(function RelayAccessPrerequisitesStep(
    props: RelayAccessPrerequisitesStepProps,
) {
    const StepComponent = props.providerId ? relayAccessPrerequisiteStepRegistry[props.providerId] : null;
    if (!StepComponent) {
        return null;
    }

    return (
        <StepComponent
            testID={props.testID}
            providerId={props.providerId}
            upstreamUrl={props.upstreamUrl}
            serverProfileId={props.serverProfileId}
            target={props.target}
            onShareUrlChange={props.onShareUrlChange}
            onWizardPrimaryChange={props.onWizardPrimaryChange}
            onRequestAdvance={props.onRequestAdvance}
        />
    );
});
