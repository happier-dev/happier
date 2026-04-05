import * as React from 'react';

import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { RelayAccessCloudflareNamedTunnelStep } from './RelayAccessCloudflareNamedTunnelStep';
import { RelayAccessLanUrlStep } from './RelayAccessLanUrlStep';

export type RelayAccessPrerequisitesStepProps = Readonly<{
    testID?: string;
    providerId: RelayAccessProviderId | null;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    onWizardPrimaryChange?: (state: Readonly<{
        label: string;
        disabled: boolean;
        onPress: (() => void) | (() => Promise<void>);
    }> | null) => void;
    onRequestAdvance?: () => void;
}>;

export const RelayAccessPrerequisitesStep = React.memo(function RelayAccessPrerequisitesStep(
    props: RelayAccessPrerequisitesStepProps,
) {
    if (props.providerId === 'cloudflareNamed') {
        return (
            <RelayAccessCloudflareNamedTunnelStep
                testID={props.testID}
                upstreamUrl={props.upstreamUrl}
                serverProfileId={props.serverProfileId}
                target={props.target}
                onWizardPrimaryChange={props.onWizardPrimaryChange}
                onRequestAdvance={props.onRequestAdvance}
            />
        );
    }

    if (props.providerId === 'lan') {
        return (
            <RelayAccessLanUrlStep
                testID={props.testID}
                upstreamUrl={props.upstreamUrl}
                serverProfileId={props.serverProfileId}
                target={props.target}
                onWizardPrimaryChange={props.onWizardPrimaryChange}
                onRequestAdvance={props.onRequestAdvance}
            />
        );
    }

    return null;
});
