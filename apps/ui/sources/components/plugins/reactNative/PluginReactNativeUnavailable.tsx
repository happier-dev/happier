import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    resolvePluginSurfaceStatePresentation,
    type PluginSurfacePresentationCopyVariant,
} from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

/**
 * Presentation consumes the exact lifecycle fact from the reset owner. A
 * successful reset is intentionally absent: it accompanies resumed content as
 * a notice, rather than being rendered as an unavailable state.
 */
export type PluginReactNativeUnavailableResetStatus =
    | 'reset_requested'
    | 'awaiting_new_projection'
    | 'reset_failed';

type PluginReactNativeUnavailableProps = Readonly<{
    diagnostics?: readonly string[];
    /** Retries only the caller's current ephemeral mount attempt. */
    onRetry?: () => void;
    /** While retrying, the canonical card owns the pending affordance. */
    retrying?: boolean;
    /** Requests an explicit daemon-owned crash-state reset for this artifact binding. */
    onReset?: () => void;
    /** Existing reset-owner lifecycle fact; diagnostics never decide recovery copy. */
    resetStatus?: PluginReactNativeUnavailableResetStatus;
    /** Respects the selected surface's reduced-motion fact for the loading glyph. */
    animationEnabled?: boolean;
}>;

function resolveRecoveryCopyVariant(
    resetStatus: PluginReactNativeUnavailableResetStatus | undefined,
): PluginSurfacePresentationCopyVariant | undefined {
    switch (resetStatus) {
        case 'reset_requested':
            return 'pluginReactNativeResetRequested';
        case 'awaiting_new_projection':
            return 'pluginReactNativeResetAwaitingProjection';
        case 'reset_failed':
            return 'pluginReactNativeResetFailed';
        case undefined:
            return undefined;
    }
}

export function PluginReactNativeUnavailable(props: PluginReactNativeUnavailableProps): React.ReactElement {
    const diagnostics = [...new Set(
        (props.diagnostics ?? []).filter((diagnostic) => diagnostic.trim().length > 0),
    )];
    const recoveryCopyVariant = resolveRecoveryCopyVariant(props.resetStatus);
    const pending = props.retrying === true
        || props.resetStatus === 'reset_requested'
        || props.resetStatus === 'awaiting_new_projection';
    const presentation = resolvePluginSurfaceStatePresentation({
        state: pending
            ? 'loading'
            : props.onRetry || recoveryCopyVariant === 'pluginReactNativeResetFailed'
                ? 'failedRetry'
                : 'unavailable',
        reasonCode: diagnostics[0],
        ...(pending ? {} : { title: t('pluginReactNative.unavailable') }),
        ...(recoveryCopyVariant === undefined ? {} : { copyVariant: recoveryCopyVariant }),
    });
    const card = presentation.card;
    if (!card) {
        throw new Error('plugin_react_native_unavailable_presentation_missing_card');
    }
    const action = !pending
        ? props.onReset
            ? { label: t('common.reset'), onPress: props.onReset }
            : props.onRetry
                ? { label: t('common.retry'), onPress: props.onRetry }
                : undefined
        : undefined;
    return (
        <SurfaceStateCard
            testID="plugin-rn-ui-unavailable"
            kind={card.kind}
            title={card.title}
            reason={card.reason}
            action={action}
            accessibilitySemantics={card.accessibilitySemantics}
            animationEnabled={props.animationEnabled}
            // The full diagnostic set stays reachable for QA via the testID
            // channel only — never in visible product copy (audit PLG-11).
            diagnosticCode={diagnostics.length > 0
                ? diagnostics.slice(0, 3).join('|')
                : presentation.diagnosticCode}
        />
    );
}
