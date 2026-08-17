import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { stageVisualTokens } from '../stage/stageVisualTokens';

export type JourneyConfigAction = () => void | Promise<void>;

export type JourneyConfigControllerSurface = Readonly<{
    body: React.ReactNode;
    onPrimary?: JourneyConfigAction | null;
    primaryLabel: React.ReactNode;
    primaryDisabled?: boolean | null;
    onBack?: JourneyConfigAction | null;
    backLabel?: React.ReactNode;
    showBack?: boolean | null;
    onSkip?: JourneyConfigAction | null;
    skipLabel?: React.ReactNode | null;
    skipDisabled?: boolean | null;
    showSkip?: boolean | null;
    footerHint?: React.ReactNode | null;
}>;

/**
 * - `scroll` (default): the config body owns its own vertical ScrollView. Used by
 *   the mobile story-scroller thumb zone where the slot is a self-contained,
 *   height-bounded region.
 * - `flow`: the slot contributes its content to a SINGLE outer ScrollView owned by
 *   the desktop narration column (R1 WorkflowPanel architecture, D18). The body
 *   flows at natural height (never clipped), a flex spacer pushes the in-flow
 *   footer + actions to the bottom, and the per-step skip is an inline quiet
 *   secondary rather than a floating trailing row.
 */
export type JourneyConfigSlotLayout = 'scroll' | 'flow';

export type JourneyConfigSlotProps = Readonly<{
    controller: JourneyConfigControllerSurface;
    layout?: JourneyConfigSlotLayout;
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        width: '100%',
        gap: 14,
    },
    rootFlow: {
        flexGrow: 1,
        minHeight: 0,
        width: '100%',
        gap: 14,
    },
    body: {
        flex: 1,
        minHeight: 0,
        width: '100%',
    },
    bodyFlow: {
        width: '100%',
        minWidth: 0,
    },
    flowSpacer: {
        flex: 1,
        minHeight: 0,
    },
    bodyContent: {
        minWidth: 0,
    },
    footerHint: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    actionBar: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        flexWrap: 'wrap',
    },
    secondaryActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        minWidth: 0,
    },
    actionButton: {
        alignItems: 'center',
        borderRadius: stageVisualTokens.narration.primaryRadius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        height: stageVisualTokens.narration.primaryHeight,
        justifyContent: 'center',
        paddingHorizontal: stageVisualTokens.narration.primaryPaddingHorizontal,
        transform: [{ scale: 1 }],
    },
    actionButtonPressed: {
        transform: [{ scale: stageVisualTokens.motion.pressScale }],
    },
    actionButtonDisabled: {
        opacity: 0.35,
    },
    primaryActionButton: {
        borderColor: 'transparent',
        backgroundColor: theme.colors.button.primary.background,
    },
    quietActionButton: {
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        paddingHorizontal: 0,
    },
    actionLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: stageVisualTokens.narration.primaryFontSize,
        lineHeight: 18,
    },
    primaryActionLabel: {
        color: theme.colors.button.primary.tint,
    },
    skipRow: {
        alignItems: 'center',
        alignSelf: 'flex-end',
        marginTop: 10,
        minHeight: 18,
        width: stageVisualTokens.narration.trailingRailWidth,
    },
    skipLabel: {
        color: theme.colors.text.tertiary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

function renderMaybeText(value: React.ReactNode): React.ReactNode {
    if (typeof value === 'string' || typeof value === 'number') {
        return <Text>{value}</Text>;
    }
    return value;
}

type WebKeyboardEvent = Readonly<{
    key?: string;
    nativeEvent?: Readonly<{
        key?: string;
    }>;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

function ConfigActionButton(props: Readonly<{
    label: React.ReactNode;
    onPress: JourneyConfigAction;
    disabled?: boolean | null;
    primary?: boolean;
    quiet?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const disabled = props.disabled === true;
    const invokePress = (): void => {
        void props.onPress();
    };
    const handleWebEnterKeyDown = (event: WebKeyboardEvent): void => {
        if (disabled || (event.key ?? event.nativeEvent?.key) !== 'Enter') {
            return;
        }

        // The controlled web runtime supplies the Enter key path without its
        // usual native-button click. Keep activation owned by this common
        // Journey action boundary, and consume the key so a browser that does
        // synthesize the click cannot advance twice.
        event.preventDefault?.();
        event.stopPropagation?.();
        invokePress();
    };
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={invokePress}
            // @ts-expect-error React Native's Pressable props omit RNW's keyboard hook.
            onKeyDown={Platform.OS === 'web' ? handleWebEnterKeyDown : undefined}
            style={({ pressed }) => [
                styles.actionButton,
                props.primary ? styles.primaryActionButton : null,
                props.quiet ? styles.quietActionButton : null,
                pressed && !disabled ? styles.actionButtonPressed : null,
                disabled ? styles.actionButtonDisabled : null,
            ]}
        >
            <Text
                numberOfLines={1}
                style={[
                    styles.actionLabel,
                    props.primary ? styles.primaryActionLabel : null,
                    props.quiet ? styles.skipLabel : null,
                ]}
            >
                {props.label}
            </Text>
        </Pressable>
    );
}

function ConfigFooterHint(props: Readonly<{
    footerHint: React.ReactNode;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View testID={props.testID}>
            {typeof props.footerHint === 'string' || typeof props.footerHint === 'number' ? (
                <Text style={styles.footerHint}>{props.footerHint}</Text>
            ) : (
                props.footerHint
            )}
        </View>
    );
}

export function JourneyConfigSlot(props: JourneyConfigSlotProps): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const testID = props.testID ?? 'journey-config-slot';
    const controller = props.controller;
    const layout: JourneyConfigSlotLayout = props.layout ?? 'scroll';
    const showBack = controller.showBack !== false && Boolean(controller.onBack);
    const showSkip = controller.showSkip !== false && Boolean(controller.onSkip);
    const showPrimary = Boolean(controller.onPrimary);
    const hasActions = showBack || showSkip || showPrimary;

    // Flow layout (D18): the body flows at natural height inside the desktop
    // column's single outer ScrollView — never bounded by an inner scroller — and
    // a flex spacer pushes the in-flow footer + action bar to the pane bottom.
    // The per-step skip lives inline as a quiet secondary so there is exactly one
    // advance affordance (primary) and no floating trailing skip/dot chrome.
    if (layout === 'flow') {
        return (
            <View testID={testID} style={styles.rootFlow}>
                <View testID={`${testID}-body`} style={styles.bodyFlow}>
                    {controller.body}
                </View>
                <View style={styles.flowSpacer} />
                {controller.footerHint ? (
                    <ConfigFooterHint footerHint={controller.footerHint} testID={`${testID}-footer`} />
                ) : null}
                {hasActions ? (
                    <View testID={`${testID}-actions`} style={styles.actionBar}>
                        <View style={styles.secondaryActions}>
                            {showBack && controller.onBack ? (
                                <ConfigActionButton
                                    testID={`${testID}-back`}
                                    label={controller.backLabel ?? t('common.back')}
                                    onPress={controller.onBack}
                                    quiet
                                />
                            ) : null}
                            {showSkip && controller.onSkip ? (
                                <ConfigActionButton
                                    testID={`${testID}-skip`}
                                    label={controller.skipLabel ?? t('common.skip')}
                                    disabled={controller.skipDisabled}
                                    onPress={controller.onSkip}
                                    quiet
                                />
                            ) : null}
                        </View>
                        {showPrimary && controller.onPrimary ? (
                            <ConfigActionButton
                                testID={`${testID}-primary`}
                                label={renderMaybeText(controller.primaryLabel)}
                                disabled={controller.primaryDisabled}
                                primary
                                onPress={controller.onPrimary}
                            />
                        ) : null}
                    </View>
                ) : null}
            </View>
        );
    }

    return (
        <View testID={testID} style={styles.root}>
            <ScrollView
                testID={`${testID}-body`}
                style={styles.body}
                contentContainerStyle={styles.bodyContent}
                showsVerticalScrollIndicator={false}
            >
                {controller.body}
            </ScrollView>
            {controller.footerHint ? (
                <ConfigFooterHint footerHint={controller.footerHint} testID={`${testID}-footer`} />
            ) : null}
            {hasActions ? (
                <>
                    <View testID={`${testID}-actions`} style={styles.actionBar}>
                        <View style={styles.secondaryActions}>
                            {showBack && controller.onBack ? (
                                <ConfigActionButton
                                    testID={`${testID}-back`}
                                    label={controller.backLabel ?? t('common.back')}
                                    onPress={controller.onBack}
                                    quiet
                                />
                            ) : null}
                        </View>
                        {showPrimary && controller.onPrimary ? (
                            <ConfigActionButton
                                testID={`${testID}-primary`}
                                label={renderMaybeText(controller.primaryLabel)}
                                disabled={controller.primaryDisabled}
                                primary
                                onPress={controller.onPrimary}
                            />
                        ) : null}
                    </View>
                    {showSkip && controller.onSkip ? (
                        <View testID={`${testID}-skip-row`} style={styles.skipRow}>
                            <ConfigActionButton
                                testID={`${testID}-skip`}
                                label={controller.skipLabel ?? t('common.skip')}
                                disabled={controller.skipDisabled}
                                onPress={controller.onSkip}
                                quiet
                            />
                        </View>
                    ) : null}
                </>
            ) : null}
        </View>
    );
}
