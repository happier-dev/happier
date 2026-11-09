import * as React from 'react';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { LocalServicePublicPreviewControls } from '@/components/sessions/localServices/LocalServicePublicPreviewControls';
import { useLocalServiceEntryActions } from '@/components/sessions/localServices/useLocalServiceEntryActions';
import { useLocalServicePresentationFeatures } from '@/components/sessions/localServices/useLocalServicePublicPreviewFeature';
import { useLocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { t } from '@/text';

const NO_LAUNCH_TARGETS = Object.freeze([]);

/**
 * Browser consumes the same consent sheet, status store and create/copy/revoke owner as Services.
 * A link is offered only beside a page the Browser can show (or the way to show it elsewhere): an
 * ended or unreachable preview has nothing to share, so its card stands alone.
 */
export function BrowserLocalPreviewPublicLinkControls(props: Readonly<{
    target: Extract<BrowserViewTargetV1, { kind: 'localServicePreview' }>;
    pageShown: boolean;
    serviceTitle: string;
    serverId?: string | null;
    testID: string;
}>): React.ReactElement | null {
    const {
        publicPreviewFeatureEnabled: enabled,
        publicPreviewCapabilityDisabledReasons: capabilityDisabledReasons,
    } = useLocalServicePresentationFeatures(props.serverId, { enabled: props.pageShown && Boolean(props.target.sessionId) });
    const state = useLocalServicePublicPreviewState({
        machineId: props.target.machineId,
        sessionId: props.target.sessionId,
        previewId: props.target.targetId,
        serverId: props.serverId,
        enabled: enabled && props.pageShown && Boolean(props.target.sessionId),
    });
    // The same Action admission as the Services surface: Account binding, cancellation and the
    // approval continuation, so an Ask-first create waits for its decision here too.
    const { handlers, review } = useLocalServiceEntryActions({
        machineId: props.target.machineId,
        serverId: props.serverId ?? null,
        sessionId: props.target.sessionId,
        scope: 'workspace',
        testID: props.testID,
    });
    // The existing public-exposure contract is Session-bound; do not manufacture a Session.
    if (!props.target.sessionId || !props.pageShown) return null;
    return <>
        {review}
        <LocalServicePublicPreviewControls launchTargets={NO_LAUNCH_TARGETS} browserTarget={props.target} serviceTitle={props.serviceTitle} state={state} actions={handlers.publicPreviewActions} capabilityDisabledReasons={capabilityDisabledReasons} testID={props.testID} />
    </>;
}

/**
 * A private preview this device was given no way to open (services lab R, H-UX F-1).
 *
 * Whether a viewer can open a private preview is decided once, by the server's preview access owner:
 * it issues an access URL for this viewer, or it does not. When it does not, the honest state is where
 * the service runs and the way that works from here, never a generic "unavailable" or a page that
 * fails to load. The machine is named from the canonical display-name projection; an unknown machine
 * reads as "another machine" rather than a raw id. Sharing a link is offered as the way to open it only
 * when this Home allows public links; until that is known the card promises nothing.
 */
export function BrowserLocalPreviewElsewhere(props: Readonly<{
    testID: string;
    serviceTitle: string;
    machineId: string;
    serverId?: string | null;
}>): React.ReactElement {
    const machineIds = React.useMemo(() => [props.machineId], [props.machineId]);
    const machineName = useMachineDisplayNamesById(machineIds)[props.machineId] ?? null;
    const sharing = useLocalServicePresentationFeatures(props.serverId).publicPreviewFeatureState;
    const reason = sharing === 'enabled' ? t('browserShell.unavailable.previewElsewhere')
        : sharing === 'disabled' || sharing === 'unsupported' ? t('browserShell.unavailable.previewElsewhereSharingOff')
            : t('browserShell.unavailable.previewElsewhereNoRoute');
    return (
        <SurfaceStateCard
            testID={`${props.testID}-elsewhere`}
            kind="unavailable"
            iconName="laptop"
            title={machineName
                ? t('browserShell.unavailable.previewElsewhereTitle', { service: props.serviceTitle, machine: machineName })
                : t('browserShell.unavailable.previewElsewhereTitleUnknownMachine', { service: props.serviceTitle })}
            reason={reason}
        />
    );
}
