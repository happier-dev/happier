import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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
    root: {
        gap: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    meta: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        ...Typography.default(),
    },
    warning: {
        color: theme.colors.state.warning.foreground,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    button: {
        alignSelf: 'flex-start',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    buttonText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
}));

function interactionStateLabel(props: BrowserDiagnosticsInteractionControls): string {
    switch (props.state) {
        case 'enabled':
            return t('browserDiagnostics.host.interaction.enabled');
        case 'disabled':
            return t('browserDiagnostics.host.interaction.disabled');
        case 'unavailable':
            return t('browserDiagnostics.host.interaction.unavailable', {
                reasonCode: props.unavailableReasonCode ?? 'policy_denied',
            });
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

function InteractionButton(props: Readonly<{
    label: string;
    onPress: () => void;
    testID: string;
}>): React.ReactElement {
    return (
        <Pressable
            accessibilityRole="button"
            onPress={props.onPress}
            style={stylesheet.button}
            testID={props.testID}
        >
            <Text style={stylesheet.buttonText}>{props.label}</Text>
        </Pressable>
    );
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
            <Text style={stylesheet.title}>{t('browserDiagnostics.host.interaction.title')}</Text>
            <Text style={props.controls.state === 'enabled' ? stylesheet.meta : stylesheet.warning}>
                {interactionStateLabel(props.controls)}
            </Text>
            {props.controls.ownerOnly ? (
                <Text style={stylesheet.meta}>{t('browserDiagnostics.host.interaction.ownerOnly')}</Text>
            ) : null}
            {pickerLabel ? (
                <Text testID={`${props.testID}-picker-${props.controls.pickerState}`} style={stylesheet.meta}>
                    {pickerLabel}
                </Text>
            ) : null}
            <View style={stylesheet.row}>
                {showEnable ? (
                    <InteractionButton
                        label={t('browserDiagnostics.host.interaction.enable')}
                        onPress={props.controls.onEnableInteraction}
                        testID={`${props.testID}-interaction-enable`}
                    />
                ) : null}
                {showDisable ? (
                    <InteractionButton
                        label={t('browserDiagnostics.host.interaction.disable')}
                        onPress={props.controls.onDisableInteraction}
                        testID={`${props.testID}-interaction-disable`}
                    />
                ) : null}
                {showStartPicker ? (
                    <InteractionButton
                        label={t('browserDiagnostics.host.interaction.startPicker')}
                        onPress={props.controls.onStartElementPicker}
                        testID={`${props.testID}-picker-start`}
                    />
                ) : null}
                {showCancelPicker ? (
                    <InteractionButton
                        label={t('browserDiagnostics.host.interaction.cancelPicker')}
                        onPress={props.controls.onCancelElementPicker}
                        testID={`${props.testID}-picker-cancel`}
                    />
                ) : null}
            </View>
            {showEvalConsole && props.controls.state === 'enabled' && props.controls.evalConsole ? (
                <BrowserDiagnosticsEvalConsole
                    controls={props.controls.evalConsole}
                    testID={`${props.testID}-eval`}
                />
            ) : null}
        </View>
    );
}
