import * as React from 'react';

import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { SystemTaskRunner } from '@/components/systemTasks/types';

import { RelayAccessConfigFieldsStep } from './RelayAccessConfigFieldsStep';
import { relayAccessConfigStepCatalog } from './relayAccessConfigStepCatalog';
import type { RelayAccessWizardPrimaryState } from './useRelayAccessWizardConfigStep';

export type RelayAccessCloudflareNamedTunnelStepProps = Readonly<{
    testID?: string;
    runner?: SystemTaskRunner;
    upstreamUrl?: string | null;
    serverProfileId?: string | null;
    target?: RelayAccessTaskTarget;
    onShareUrlChange?: (shareUrl: string | null) => void;
    onWizardPrimaryChange?: (state: RelayAccessWizardPrimaryState | null) => void;
    onRequestAdvance?: () => void;
}>;

export const RelayAccessCloudflareNamedTunnelStep = React.memo(function RelayAccessCloudflareNamedTunnelStep(
    props: RelayAccessCloudflareNamedTunnelStepProps,
) {
    return (
        <RelayAccessConfigFieldsStep
            {...props}
            definition={relayAccessConfigStepCatalog.cloudflareNamed}
        />
    );
});
