import * as React from 'react';

import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';

export type RelayAccessTailscalePrerequisitesStepProps = Readonly<{
    testID?: string;
    providerId: 'tailscaleServe' | 'tailscaleFunnel';
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
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
            onShareUrlChange={props.onShareUrlChange}
            forcedProviderId={props.providerId}
            showProviderChoices={false}
            allowWizardDetailsRedirect={false}
            onWizardPrimaryChange={props.onWizardPrimaryChange}
            onRequestAdvance={props.onRequestAdvance}
        />
    );
});
