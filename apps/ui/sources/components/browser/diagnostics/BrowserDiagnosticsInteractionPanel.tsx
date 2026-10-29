import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Typography } from '@/constants/Typography';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

import { BrowserDiagnosticsEvalConsole } from './BrowserDiagnosticsEvalConsole';
import type { BrowserDiagnosticsEvalConsoleControls } from './BrowserDiagnosticsEvalConsole';

export type { BrowserDiagnosticsEvalConsoleControls } from './BrowserDiagnosticsEvalConsole';

export type BrowserDiagnosticsInteractionControls = Readonly<{
    state: 'disabled' | 'enabled' | 'unavailable';
    ownerOnly: boolean;
    canEnable?: boolean;
    unavailableReasonCode?: string;
    pickerState?: 'idle' | 'active' | 'unavailable';
    onEnableInteraction?: () => void;
    onDisableInteraction?: () => void;
    onStartElementPicker?: () => void;
    onCancelElementPicker?: () => void;
    /**
     * DEV-3/DEV-4: the local-owner eval REPL + expandable object inspector. Present only while
     * interaction is `enabled` (eval is owner-only and floored for the agent surface — see LANE-CONSENT).
     */
    evalConsole?: BrowserDiagnosticsEvalConsoleControls;
}>;

export type BrowserDiagnosticsInteractionSurface = 'all' | 'console' | 'elements';

const stylesheet = StyleSheet.create((theme) => ({
    // One line in the tab's own flow (what the tools would do, and the switch for them), not a box
    // around a mechanism.
    root: {
        gap: theme.space.s8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    meta: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));

function interactionStateLabel(props: BrowserDiagnosticsInteractionControls): string {
    switch (props.state) {
        case 'enabled':
            return t('browserDiagnostics.host.interaction.enabled');
        case 'disabled':
            return t('browserDiagnostics.host.interaction.disabled');
        case 'unavailable':
            // The code stays a diagnostic; the person reads why the tools are off.
            return resolveReasonCopy({ reasonCode: props.unavailableReasonCode ?? 'policy_denied', kind: 'browserDiagnosticsInteraction' }).body;
    }
}

function pickerStateLabel(state: BrowserDiagnosticsInteractionControls['pickerState']): string | null {
    switch (state) {
        case 'active':
            return t('browserDiagnostics.host.interaction.pickerActive');
        case 'unavailable':
            return t('browserDiagnostics.host.interaction.pickerUnavailable');
        case 'idle':
        case undefined:
            return null;
    }
}

export function BrowserDiagnosticsInteractionPanel(props: Readonly<{
    controls: BrowserDiagnosticsInteractionControls;
    surface?: BrowserDiagnosticsInteractionSurface;
    testID: string;
}>): React.ReactElement {
    const surface = props.surface ?? 'all';
    const showElementPicker = surface === 'all' || surface === 'elements';
    const showEvalConsole = surface === 'all' || surface === 'console';
    const pickerLabel = showElementPicker ? pickerStateLabel(props.controls.pickerState) : null;
    const showEnable = (
        props.controls.state === 'disabled'
        && props.controls.canEnable === true
        && typeof props.controls.onEnableInteraction === 'function'
    );
    const showDisable = (
        props.controls.state === 'enabled'
        && typeof props.controls.onDisableInteraction === 'function'
    );
    const showStartPicker = (
        showElementPicker
        && props.controls.state === 'enabled'
        && props.controls.pickerState === 'idle'
        && typeof props.controls.onStartElementPicker === 'function'
    );
    const showCancelPicker = (
        showElementPicker
        && props.controls.state === 'enabled'
        && props.controls.pickerState === 'active'
        && typeof props.controls.onCancelElementPicker === 'function'
    );

    return (
        <View testID={`${props.testID}-interaction-${props.controls.state}`} style={stylesheet.root}>
            {/* The state line says what the tools do on this page ("Let Diagnostics run code and pick
              * elements on this page"), so its button only needs to say Allow or Turn off. */}
            <View style={stylesheet.row}>
                <Text style={stylesheet.meta}>
                    {interactionStateLabel(props.controls)}
                </Text>
                {showEnable ? (
                    <ToolbarButton
                        label={t('browserDiagnostics.host.interaction.enable')}
                        onPress={props.controls.onEnableInteraction}
                        testID={`${props.testID}-interaction-enable`}
                    />
                ) : null}
                {showDisable ? (
                    <ToolbarButton
                        label={t('browserDiagnostics.host.interaction.disable')}
                        onPress={props.controls.onDisableInteraction}
                        testID={`${props.testID}-interaction-disable`}
                    />
                ) : null}
            </View>
            {/* Who may turn the tools on is news only to a viewer who can't: the owner has the button. */}
            {props.controls.ownerOnly && props.controls.state === 'disabled' && props.controls.canEnable !== true ? (
                <Text style={stylesheet.meta}>{t('browserDiagnostics.host.interaction.ownerOnly')}</Text>
            ) : null}
            {pickerLabel ? (
                <Text testID={`${props.testID}-picker-${props.controls.pickerState}`} style={stylesheet.meta}>
                    {pickerLabel}
                </Text>
            ) : null}
            {showStartPicker || showCancelPicker ? <View style={stylesheet.row}>
                {showStartPicker ? (
                    <ToolbarButton
                        label={t('browserDiagnostics.host.interaction.startPicker')}
                        onPress={props.controls.onStartElementPicker}
                        testID={`${props.testID}-picker-start`}
                    />
                ) : null}
                {showCancelPicker ? (
                    <ToolbarButton
                        label={t('browserDiagnostics.host.interaction.cancelPicker')}
                        onPress={props.controls.onCancelElementPicker}
                        testID={`${props.testID}-picker-cancel`}
                    />
                ) : null}
            </View> : null}
            {showEvalConsole && props.controls.state === 'enabled' && props.controls.evalConsole ? (
                <BrowserDiagnosticsEvalConsole
                    controls={props.controls.evalConsole}
                    testID={`${props.testID}-eval`}
                />
            ) : null}
        </View>
    );
}
