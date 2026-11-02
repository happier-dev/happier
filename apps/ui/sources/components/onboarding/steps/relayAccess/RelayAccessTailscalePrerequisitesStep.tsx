import * as React from 'react';

import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { RelayAccessControlOptions } from '@/components/settings/server/relayAccess/useRelayAccessControl';

import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';

export type RelayAccessTailscalePrerequisitesStepProps = Readonly<{
    testID?: string;
    /** A provider whose descriptor runs the Tailscale secure-access task (decided by the caller). */
    providerId: RelayAccessProviderId;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    runWithTarget?: RelayAccessControlOptions['runWithTarget'];
    remoteHost?: RelayAccessControlOptions['remoteHost'];
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: Readonly<{
        label: string;
        disabled: boolean;
        onPress: (() => void) | (() => Promise<void>);
    }> | null) => void;
    onRequestAdvance?: () => void;
}>;

export const RelayAccessTailscalePrerequisitesStep = React.memo(function RelayAccessTailscalePrerequisitesStep(
    props: RelayAccessTailscalePrerequisitesStepProps,
) {
    return (
        <LocalRelayAccessControlSection
            testID={props.testID}
            presentation="wizard"
            upstreamUrl={props.upstreamUrl}
            serverProfileId={props.serverProfileId}
            target={props.target}
            runWithTarget={props.runWithTarget}
            remoteHost={props.remoteHost}
            onShareUrlChange={props.onShareUrlChange}
            forcedProviderId={props.providerId}
            showProviderChoices={false}
            allowWizardDetailsRedirect={false}
            onWizardPrimaryChange={props.onWizardPrimaryChange}
            onRequestAdvance={props.onRequestAdvance}
        />
    );
});
