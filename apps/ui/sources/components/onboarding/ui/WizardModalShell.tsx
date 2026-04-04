import * as React from 'react';
import { Platform, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';

import { WizardCardLayout } from './WizardCardLayout';
import { WizardStepDots } from './WizardStepDots';
import { shouldUseWizardFullscreenPresentation } from './wizardPresentation';

function isRelayFooterHint(node: React.ReactNode): node is React.ReactElement<{ testID?: string }> {
    if (!React.isValidElement(node)) return false;
    const testID = (node.props as { testID?: unknown }).testID;
    return typeof testID === 'string' && testID.includes('relay-hint');
}

function forceSingleLineText(node: React.ReactNode): React.ReactNode {
    if (!React.isValidElement(node)) return node;

    const children = React.Children.map((node.props as { children?: React.ReactNode }).children, forceSingleLineText);

    if (node.type === Text) {
        const element = node as React.ReactElement<React.ComponentProps<typeof Text>>;
        return React.cloneElement(
            element,
            {
                ...element.props,
                numberOfLines: 1,
                ellipsizeMode: element.props.ellipsizeMode ?? 'middle',
            },
            children
        );
    }

    const element = node as React.ReactElement<Record<string, unknown>>;
    return React.cloneElement(element, undefined, children);
}

export type WizardModalShellProps = Readonly<{
    titleLeading?: React.ReactNode;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children: React.ReactNode;
    stepIndex: number;
    stepCount: number;
    headerHint?: React.ReactNode;
    onSkip?: () => void;
    onBack?: () => void;
    onPrimary?: () => void;
    onSecondary?: () => void;
    primaryLabel?: React.ReactNode;
    secondaryLabel?: React.ReactNode;
    skipLabel?: React.ReactNode;
    backLabel?: React.ReactNode;
    primaryDisabled?: boolean;
    secondaryDisabled?: boolean;
    showSkip?: boolean;
    showBack?: boolean;
    skipDisabled?: boolean;
    footerHint?: React.ReactNode;
    testID?: string;
    contentStyle?: StyleProp<ViewStyle>;
    scrollable?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    shell: {
        flexDirection: 'column',
        flexShrink: 1,
        minHeight: 0,
    },
    shellFullscreen: {
        flex: 1,
        minHeight: '100%',
    },
    header: {
        paddingHorizontal: 22,
        paddingTop: 18,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerSide: {
        minWidth: 76,
        flexShrink: 0,
        alignItems: 'flex-start',
    },
    headerCenter: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
    },
    headerHint: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    skip: {
        alignItems: 'flex-end',
    },
    scroll: {
        minHeight: 0,
    },
    content: {
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 22,
        gap: 16,
    },
    titleBlock: {
        gap: 8,
        alignItems: 'center',
        alignSelf: 'center',
        width: '100%',
        maxWidth: 420,
    },
    titleLeading: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 24,
        lineHeight: 30,
        color: theme.colors.text,
        letterSpacing: -0.4,
        textAlign: 'center',
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 21,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    body: {
        gap: 16,
        width: '100%',
    },
    footer: {
        paddingHorizontal: 24,
        paddingTop: 4,
        paddingBottom: 24,
        gap: 10,
    },
    footerHint: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    footerHintContainer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    footerButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        flexWrap: 'wrap',
    },
    footerButton: {
        flex: 1,
        minWidth: 160,
    },
    footerSecondaryButton: {
    },
}));

export function WizardModalShell(props: WizardModalShellProps) {
    useUnistyles();
    const styles = stylesheet;
    const { width: windowWidth } = useWindowDimensions();
    const rawInsets = useChromeSafeAreaInsets();
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const insets = React.useMemo(() => {
        // On native, BaseModal already applies safe-area padding at the overlay container level.
        // Avoid double-applying insets inside the wizard chrome.
        if (Platform.OS !== 'web' && isInsideModalBoundary) {
            return { top: 0, bottom: 0, left: 0, right: 0 } as const;
        }
        return rawInsets;
    }, [isInsideModalBoundary, rawInsets]);
    const showSkip = props.showSkip ?? true;
    const showBack = props.showBack ?? true;
    const skipDisabled = props.skipDisabled ?? false;
    const wantsFullscreen = shouldUseWizardFullscreenPresentation(windowWidth);
    const shouldDisableInternalScrim = isInsideModalBoundary;
    const shouldUseInternalScrollHost = props.scrollable ?? !isInsideModalBoundary;
    const headerPaddingTop = (wantsFullscreen ? 12 : 18) + insets.top;
    const footerPaddingBottom = (wantsFullscreen ? 16 : styles.footer.paddingBottom) + insets.bottom;

    const content = (
        <>
            {props.title || props.subtitle ? (
                <View style={styles.titleBlock}>
                    {props.titleLeading ? <View style={styles.titleLeading}>{props.titleLeading}</View> : null}
                    {props.title ? <Text style={styles.title}>{props.title}</Text> : null}
                    {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
                </View>
            ) : null}

            <View style={[styles.body, props.contentStyle]}>{props.children}</View>
        </>
    );

    return (
            <WizardCardLayout
                testID={props.testID}
                scrollable={shouldUseInternalScrollHost}
                showScrim={shouldDisableInternalScrim ? false : true}
            >
                <View
                    testID={props.testID}
                    style={[
                        styles.shell,
                        wantsFullscreen ? styles.shellFullscreen : null,
                    ]}
                >
                <View style={[styles.header, { paddingTop: headerPaddingTop }]}>
                    <View style={styles.headerSide}>
                        <HeaderLogo />
                    </View>
                    <View style={styles.headerCenter}>
                        <WizardStepDots currentStepIndex={props.stepIndex} stepCount={props.stepCount} />
                        {props.headerHint
                            ? typeof props.headerHint === 'string' || typeof props.headerHint === 'number'
                                ? <Text style={styles.headerHint}>{props.headerHint}</Text>
                                : props.headerHint
                            : null}
                    </View>
                    <View style={[styles.headerSide, styles.skip]}>
                        {showSkip && props.onSkip ? (
                            <RoundButton
                                testID={`${props.testID ?? 'wizard'}-skip`}
                                size="small"
                                display="inverted"
                                title={props.skipLabel ?? t('common.skip')}
                                disabled={skipDisabled}
                                onPress={props.onSkip}
                            />
                        ) : null}
                    </View>
                </View>

                <View style={[styles.scroll, styles.content]}>
                    {content}
                </View>

                <View style={[styles.footer, { paddingBottom: footerPaddingBottom }]}>
                    {props.footerHint
                        ? typeof props.footerHint === 'string' || typeof props.footerHint === 'number'
                            ? <Text style={styles.footerHint}>{props.footerHint}</Text>
                            : <View style={styles.footerHintContainer}>
                                {isRelayFooterHint(props.footerHint)
                                    ? forceSingleLineText(props.footerHint)
                                    : props.footerHint}
                              </View>
                        : null}
                    <View style={styles.footerButtons}>
                        {showBack && props.onBack ? (
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID={`${props.testID ?? 'wizard'}-back`}
                                    size="normal"
                                    display="inverted"
                                    style={styles.footerSecondaryButton}
                                    title={props.backLabel ?? t('common.back')}
                                    onPress={props.onBack}
                                />
                            </View>
                        ) : null}
                        {props.onSecondary ? (
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID={`${props.testID ?? 'wizard'}-secondary`}
                                    size="normal"
                                    display="inverted"
                                    style={styles.footerSecondaryButton}
                                    title={props.secondaryLabel ?? t('common.cancel')}
                                    disabled={props.secondaryDisabled}
                                    onPress={props.onSecondary}
                                />
                            </View>
                        ) : null}
                        {props.onPrimary ? (
                            <View style={styles.footerButton}>
                                <RoundButton
                                    testID={`${props.testID ?? 'wizard'}-primary`}
                                    size="normal"
                                    title={props.primaryLabel ?? t('common.continue')}
                                    disabled={props.primaryDisabled}
                                    onPress={props.onPrimary}
                                />
                            </View>
                        ) : null}
                    </View>
                </View>
            </View>
        </WizardCardLayout>
    );
}
