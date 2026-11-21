import * as React from 'react';

import { resolvePluginSurfaceStateAction } from '@/components/sessions/panes/PluginSurfaceFallback';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { isPluginSurfaceCauseOutsidePlugin, resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';
import { useClaimedHostFailureNotice } from '@/components/ui/surfaces/claimableSurfaceNotice';
import { t } from '@/text';

import { PluginSurfaceMachineRecoveryContext, useOfflineSurfaceNotice } from '../shared/pluginSurfaceInteractionAvailability';
import { usePublishPluginSurfaceStateTitle } from '../shared/pluginSurfaceStateTitle';

type PluginReactNativeUnavailableProps = Readonly<{
    diagnostics?: readonly string[];
    /** Retries only the caller's current ephemeral mount attempt. */
    onRetry?: () => void;
    /** Route-owned recovery callback; the shared presentation owner supplies its semantic label. */
    recoveryAction?: SurfaceStateAction;
    /** While retrying, the canonical card owns the pending affordance. */
    retrying?: boolean;
    /** Respects the selected surface's reduced-motion fact for the loading glyph. */
    animationEnabled?: boolean;
    /** The plugin's display name, so a whole-page card says which plugin failed. */
    subjectName?: string;
    /**
     * The surface's runtime is not reachable (its machine is offline or a chosen source has not answered), so
     * nothing could load. The card then says that cause, through the one cold-state owner, instead of a generic
     * "couldn't open".
     */
    offline?: boolean;
}>;

export function PluginReactNativeUnavailable(props: PluginReactNativeUnavailableProps): React.ReactElement {
    const diagnostics = [...new Set(
        (props.diagnostics ?? []).filter((diagnostic) => diagnostic.trim().length > 0),
    )];
    const pending = props.retrying === true;
    const offlineNotice = useOfflineSurfaceNotice(false, props.subjectName ?? '');
    // The host's Machine recovery: an offline card that says "choose another machine" offers that choice.
    const machineRecovery = React.useContext(PluginSurfaceMachineRecoveryContext);
    const presentation = resolvePluginSurfaceStatePresentation({
        state: pending
            ? 'loading'
            : props.onRetry
                ? 'failedRetry'
                : 'unavailable',
        reasonCode: diagnostics[0],
        subjectName: props.subjectName,
        ...(pending ? {} : { title: t('pluginReactNative.unavailable') }),
    });
    const card = presentation.card;
    if (!card) {
        throw new Error('plugin_react_native_unavailable_presentation_missing_card');
    }
    const action = pending
        ? undefined
        : resolvePluginSurfaceStateAction({
            recoveryAction: presentation.recoveryAction,
            onRetry: props.onRetry,
            manageAction: props.recoveryAction,
        });
    const offline = props.offline === true && !pending;
    // The host's line about this body (its widget's Machine notice) and this failure are one failure, said once.
    const hostNotice = useClaimedHostFailureNotice(!pending, isPluginSurfaceCauseOutsidePlugin(diagnostics[0]));
    const claimedSentence = hostNotice?.sentence ?? null;
    const title = claimedSentence ?? (offline ? offlineNotice.title : card.title);
    usePublishPluginSurfaceStateTitle(pending ? null : title);
    return (
        <SurfaceStateCard
            testID="plugin-rn-ui-unavailable"
            kind={claimedSentence !== null ? 'unavailable' : offline ? offlineNotice.kind : card.kind}
            title={title}
            {...(claimedSentence !== null ? { size: 'line' as const }
                : { reason: offline ? offlineNotice.reason : card.reason })}
            action={claimedSentence !== null && hostNotice?.action !== undefined ? hostNotice.action ?? undefined
                : action ?? (offline ? machineRecovery?.retry : undefined)}
            secondaryAction={claimedSentence === null && offline ? machineRecovery?.chooseMachine : undefined}
            accessibilitySemantics={card.accessibilitySemantics}
            animationEnabled={props.animationEnabled}
            // Details exposes the diagnostic codes separately from the recovery copy.
            diagnosticCode={diagnostics.length > 0
                ? diagnostics.slice(0, 3).join('|')
                : presentation.diagnosticCode}
        />
    );
}
