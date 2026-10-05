import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { AnchoredWidgetShell, WidgetSheetShell } from '@/components/widgets/add/WidgetAddPopover';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

/** About, Save as your widget and Post a snapshot share the Set up step's width class and anchoring. */
const PANEL_WIDTH_PX = 560;

/**
 * One widget flow, anchored to the card's ⋯ on desktop and a bottom sheet on a phone — the same
 * shells the Add and Set up flows use. Mounted only while open.
 */
export function WidgetFlowShell(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    title: string;
    onRequestClose: () => void;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const phone = useDeviceType() === 'phone';
    return phone ? (
        <WidgetSheetShell title={props.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>{props.children}</WidgetSheetShell>
    ) : (
        <AnchoredWidgetShell anchorRef={props.anchorRef} placement="bottom" width={PANEL_WIDTH_PX} onRequestClose={props.onRequestClose}>
            {props.children}
        </AnchoredWidgetShell>
    );
}

export type WidgetPanelPrimary = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    /** Why the primary is off, said beside it and read with it. */
    blockedReason?: string | null;
}>;

/**
 * The flow's anatomy (lab dagent G3, dscope VS): a header with Back where there is somewhere to go
 * back to, its body, and one footer — a quiet note at the start, Cancel, and exactly one primary.
 */
export function WidgetDefinitionPanel(props: Readonly<{
    title: string;
    hint?: string;
    onBack?: () => void;
    /** Quiet words in the footer ("Saved to your account · only you"), or the reason the primary is off. */
    note?: string | null;
    error?: string | null;
    onCancel?: () => void;
    primary?: WidgetPanelPrimary;
    /** Secondary actions that sit in the footer start instead of a note (About's Duplicate). */
    footerStart?: React.ReactNode;
    testID: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const message = props.error ?? props.primary?.blockedReason ?? props.note ?? null;
    return (
        <View testID={props.testID} accessibilityLabel={props.title} style={styles.root}>
            <View style={styles.header}>
                {props.onBack ? (
                    <HappierPressable
                        testID={`${props.testID}.back`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        onPress={props.onBack}
                        style={(state) => [styles.back, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Icon name="caret-left" size={16} color={theme.colors.text.secondary} />
                    </HappierPressable>
                ) : null}
                <View style={styles.titleBlock}>
                    <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>{props.title}</Text>
                    {props.hint ? <Text style={styles.hint}>{props.hint}</Text> : null}
                </View>
            </View>
            <View style={styles.body}>{props.children}</View>
            {props.primary || props.onCancel || props.footerStart || message ? (
                <View style={styles.footer}>
                    {props.footerStart ?? (
                        <Text style={[styles.note, props.error ? styles.noteError : null]} testID={`${props.testID}.note`} accessibilityLiveRegion="polite">
                            {message ?? ''}
                        </Text>
                    )}
                    {props.onCancel ? (
                        <RoundButton testID={`${props.testID}.cancel`} size="small" display="secondary" title={t('common.cancel')} onPress={props.onCancel} />
                    ) : null}
                    {props.primary ? (
                        <RoundButton
                            testID={`${props.testID}.primary`}
                            size="small"
                            title={props.primary.label}
                            disabled={props.primary.disabled === true || props.primary.busy === true}
                            loading={props.primary.busy === true}
                            {...(props.primary.blockedReason ? { accessibilityHint: props.primary.blockedReason } : {})}
                            onPress={props.primary.onPress}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

/** One fact row of About (lab G2): a quiet label column, the fact, and its consequence beneath. */
export function WidgetFactRow(props: Readonly<{
    label: string;
    children: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const phone = useDeviceType() === 'phone';
    const styles = stylesheet;
    return (
        <View testID={props.testID} style={[styles.fact, phone ? styles.factPhone : null]} accessible={false}>
            <Text style={[styles.factLabel, phone ? styles.factLabelPhone : null]}>{props.label}</Text>
            <View style={styles.factBody}>{props.children}</View>
        </View>
    );
}

export const widgetPanelText = StyleSheet.create((theme) => ({
    primary: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), fontSize: 13.5, color: theme.colors.text.primary },
    strong: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
    secondary: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.tertiary },
    link: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
}));

const stylesheet = StyleSheet.create((theme) => ({
    root: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 8 },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 8 },
    back: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginTop: -2 },
    titleBlock: { flex: 1, minWidth: 0, gap: 2, paddingTop: 1 },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary },
    hint: { ...Typography.default(), fontSize: 12, lineHeight: 16, color: theme.colors.text.tertiary },
    body: { paddingHorizontal: 4, gap: 0 },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
        paddingTop: 10,
        paddingHorizontal: 4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    note: { ...Typography.default(), flex: 1, fontSize: 12, lineHeight: 16, color: theme.colors.text.tertiary },
    noteError: { color: theme.colors.state.danger.foreground },
    fact: {
        flexDirection: 'row',
        gap: 12,
        paddingVertical: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    factPhone: { flexDirection: 'column', gap: 2 },
    factLabel: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), width: 88, color: theme.colors.text.tertiary },
    factLabelPhone: { width: undefined },
    factBody: { flex: 1, minWidth: 0, gap: 2 },
}));
