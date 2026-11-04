import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { HappierPressable, happierPageTextMetrics, withHappierPageSectionDividers } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { VoiceReadinessGlyph, type VoiceReadinessTone } from './VoiceReadinessGlyph';

export type VoicePipelineAction = Readonly<{ label: string; onPress: () => void; testID?: string; disabled?: boolean }>;

/** What one step of a pipeline needs, said once with the one action that fixes it. */
export type VoicePipelineStepReadiness = Readonly<{
    tone: Exclude<VoiceReadinessTone, 'ready' | 'unknown'>;
    message: string;
    action?: VoicePipelineAction;
    /** A real install's progress, 0–1, only while it runs. */
    progress?: number | null;
}>;

export type VoicePipelineStep = Readonly<{
    key: string;
    /** The role(s) this step plays: "Hear", or "Hear · Think · Speak" for a service that owns all three. */
    roleLabel: string;
    /** The engine's identity mark (a service, agent or speech-engine mark). */
    mark: React.ReactNode;
    name: string;
    /** Where it runs or goes, in words ("On devbox · localhost:8000"). */
    where: string;
    whereIcon: IconName;
    /** Absent when the step is ready: healthy steps stay quiet. */
    readiness?: VoicePipelineStepReadiness | null;
    /** The step whose section the page below is editing. */
    selected?: boolean;
}>;

export type VoicePipelineCardProps = Readonly<{
    title: string;
    status: Readonly<{ tone: VoiceReadinessTone; text: string }>;
    steps: readonly VoicePipelineStep[];
    /** One quiet line under the steps, with an optional action at its end. */
    footer?: Readonly<{ icon: IconName; text: string; action?: VoicePipelineAction }> | null;
    /** What the whole service still needs (not one step's), with the one action that fixes it. */
    serviceReadiness?: VoicePipelineStepReadiness | null;
    /** Rows that belong to the pipeline itself (its explicit setup check and result), under the steps. */
    children?: React.ReactNode;
    /** The whole card leads to its page (the Voice hub's mode cards). */
    onPress?: () => void;
    /** `auto` lays the steps out as a flow when the card is wide enough, as rows when it is not. */
    layout?: 'auto' | 'rows';
    testID?: string;
}>;

/**
 * A Voice mode's pipeline: what hears you, what thinks and what speaks, where each runs and whether
 * it works. Wide cards read left to right (Hear → Think → Speak); narrow ones recompose into rows.
 * Each step shows its own readiness and the one action that fixes it; healthy steps say nothing.
 */
export const VoicePipelineCard = React.memo(function VoicePipelineCard(props: VoicePipelineCardProps) {
    const { theme } = useUnistyles();
    const [narrow, setNarrow] = React.useState(false);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (!Number.isFinite(width) || width <= 0) return;
        const next = width < PAGE_LIST_METRICS.rowStackBelowWidthPx;
        setNarrow((current) => (current === next ? current : next));
    }, []);
    const rows = props.layout === 'rows' || narrow;

    const header = (
        <View style={styles.header}>
            <View style={styles.headerText}>
                <Text style={styles.title}>{props.title}</Text>
                <View style={styles.statusLine}>
                    {props.status.tone === 'unknown' ? null : <View style={styles.glyphSlot}><VoiceReadinessGlyph tone={props.status.tone} /></View>}
                    <Text style={styles.statusText}>{props.status.text}</Text>
                </View>
            </View>
            {props.onPress ? (
                <Icon name="caret-right" size={16} color={theme.colors.text.tertiary} />
            ) : null}
        </View>
    );

    return (
        <View testID={props.testID} onLayout={onLayout} style={styles.card}>
            {props.onPress ? (
                <HappierPressable
                    accessibilityRole="button"
                    accessibilityLabel={`${props.title}. ${props.status.text}`}
                    onPress={props.onPress}
                    style={({ hovered }: { hovered?: boolean }) => [hovered ? styles.headerHovered : null]}
                >
                    {header}
                </HappierPressable>
            ) : header}
            {rows ? (
                <StepsPressArea onPress={props.onPress} style={styles.rows}>
                    {withHappierPageSectionDividers(props.steps.map((step) => <PipelineStepRow key={step.key} step={step} />))}
                </StepsPressArea>
            ) : (
                <StepsPressArea onPress={props.onPress} style={styles.flow}>
                    {props.steps.map((step, index) => (
                        <React.Fragment key={step.key}>
                            {index > 0 ? (
                                <View style={styles.arrow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                                    <Icon name="arrow-right" size={14} color={theme.colors.text.tertiary} />
                                </View>
                            ) : null}
                            <PipelineStepTile step={step} />
                        </React.Fragment>
                    ))}
                </StepsPressArea>
            )}
            {props.children ? <View style={styles.rowsSlot}>{props.children}</View> : null}
            {props.serviceReadiness ? (
                <View style={styles.footer}>
                    <View style={styles.footerReadiness}>
                        <StepReadiness readiness={props.serviceReadiness} />
                    </View>
                </View>
            ) : null}
            {props.footer ? (
                <View style={styles.footer}>
                    <Icon name={props.footer.icon} size={14} color={theme.colors.text.secondary} />
                    <Text style={styles.footerText}>{props.footer.text}</Text>
                    {props.footer.action ? (
                        <RoundButton
                            testID={props.footer.action.testID}
                            size="small"
                            display="secondary"
                            title={props.footer.action.label}
                            disabled={props.footer.action.disabled}
                            onPress={props.footer.action.onPress}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});

function StepReadiness(props: Readonly<{ readiness: VoicePipelineStepReadiness }>) {
    const { readiness } = props;
    const toneStyle = readiness.tone === 'needs_you'
        ? styles.readinessNeedsYou
        : readiness.tone === 'blocked'
            ? styles.readinessBlocked
            : styles.readinessQuiet;
    return (
        <View style={styles.readiness}>
            <View style={styles.readinessLine}>
                <View style={styles.glyphSlot}><VoiceReadinessGlyph tone={readiness.tone} /></View>
                <Text style={[styles.readinessText, toneStyle]}>{readiness.message}</Text>
            </View>
            {readiness.action ? (
                <View style={styles.readinessAction}>
                    <RoundButton
                        testID={readiness.action.testID}
                        size="small"
                        display="secondary"
                        title={readiness.action.label}
                        disabled={readiness.action.disabled}
                        onPress={readiness.action.onPress}
                    />
                </View>
            ) : null}
            {typeof readiness.progress === 'number' ? (
                <View
                    style={styles.progressTrack}
                    accessibilityRole="progressbar"
                    accessibilityValue={{ min: 0, max: 100, now: Math.round(readiness.progress * 100) }}
                >
                    <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, readiness.progress)) * 100}%` }]} />
                </View>
            ) : null}
        </View>
    );
}

function PipelineStepTile(props: Readonly<{ step: VoicePipelineStep }>) {
    const { theme } = useUnistyles();
    const { step } = props;
    // Amber asks for the person; rose says the step cannot work here (VE-01).
    const toneStyle = step.readiness?.tone === 'blocked'
        ? styles.tileBlocked
        : step.readiness?.tone === 'needs_you' ? styles.tileNeedsYou : null;
    return (
        <View
            accessibilityLabel={`${step.roleLabel}: ${step.name}. ${step.where}`}
            style={[styles.tile, toneStyle, step.selected ? styles.tileSelected : null]}
        >
            <Text style={styles.role} numberOfLines={1}>{step.roleLabel}</Text>
            {/* A tile is one line per fact; what does not fit ellipsizes and the row form shows it whole. */}
            <View style={styles.engine}>
                <View style={styles.mark}>{step.mark}</View>
                <Text style={styles.engineName} numberOfLines={1}>{step.name}</Text>
            </View>
            <View style={styles.where}>
                <View style={styles.whereGlyph}>
                    <Icon name={step.whereIcon} size={13} color={theme.colors.text.secondary} />
                </View>
                <Text style={styles.whereText} numberOfLines={1}>{step.where}</Text>
            </View>
            {step.readiness ? <StepReadiness readiness={step.readiness} /> : null}
        </View>
    );
}

function PipelineStepRow(props: Readonly<{ step: VoicePipelineStep; showDivider?: boolean }>) {
    const { step } = props;
    return (
        <View accessibilityLabel={`${step.roleLabel}: ${step.name}`} style={[styles.row, props.showDivider ? styles.rowDivider : null]}>
            <Text style={styles.rowRole}>{step.roleLabel.split(' · ').join('\n')}</Text>
            <View style={styles.rowBody}>
                <View style={styles.engine}>
                    <View style={styles.mark}>{step.mark}</View>
                    <Text style={styles.engineName}>{step.name}</Text>
                </View>
                <Text style={styles.rowWhere}>{step.where}</Text>
                {/* Phones recompose: the step's one action sits beneath its reason, never beside the text. */}
                {step.readiness ? <StepReadiness readiness={step.readiness} /> : null}
            </View>
        </View>
    );
}

/**
 * A card that opens a page opens it from anywhere on the card, not only its header. The header stays
 * the one accessible button; this area is pointer-only, and a step's own action still wins its press.
 */
function StepsPressArea(props: Readonly<{ onPress?: () => void; style: StyleProp<ViewStyle>; children: React.ReactNode }>) {
    if (!props.onPress) return <View style={props.style}>{props.children}</View>;
    return (
        <Pressable accessible={false} focusable={false} onPress={props.onPress} style={props.style}>
            {props.children}
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: PAGE_LIST_METRICS.sheetRadiusPx + 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.sectionTint,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingTop: 14,
        paddingBottom: theme.space.s12,
        paddingLeft: 18,
        paddingRight: theme.space.s16,
    },
    headerHovered: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        letterSpacing: 0,
        color: theme.colors.text.primary,
    },
    statusLine: {
        marginTop: theme.space.s2,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
    },
    // A status glyph sits on the first line of its text, however far the text wraps.
    glyphSlot: {
        height: happierPageTextMetrics('rowDescription').lineHeight,
        justifyContent: 'center',
    },
    statusText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    flow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        paddingHorizontal: theme.space.s10,
        paddingBottom: theme.space.s10,
    },
    arrow: {
        width: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tile: {
        flex: 1,
        minWidth: 0,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s12,
        gap: theme.space.s4,
        // A step is one more tint layer inside the card's tint: a breath darker on light and a small
        // lift on dark (DESIGN.md: dark is layered, not inverted). `inset` is the navigation plane,
        // which sits below the page on dark and made the steps read sunken.
        backgroundColor: theme.colors.surface.sectionTint,
    },
    tileNeedsYou: {
        backgroundColor: theme.colors.state.warning.background,
    },
    tileBlocked: {
        backgroundColor: theme.colors.state.danger.background,
    },
    tileSelected: {
        borderWidth: 1.5,
        borderColor: theme.colors.text.primary,
        paddingHorizontal: 12.5,
        paddingVertical: 10.5,
    },
    role: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    // A name that wraps keeps its mark on the first line; the mark's box is one title line tall.
    engine: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        minWidth: 0,
    },
    mark: {
        flexShrink: 0,
        height: happierPageTextMetrics('rowTitle').lineHeight,
        justifyContent: 'center',
    },
    engineName: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        letterSpacing: 0,
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    where: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
        minWidth: 0,
    },
    whereGlyph: {
        flexShrink: 0,
        height: happierPageTextMetrics('rowDescription').lineHeight,
        justifyContent: 'center',
    },
    whereText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    readiness: {
        marginTop: theme.space.s6,
        gap: theme.space.s8,
    },
    readinessLine: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s6,
    },
    readinessText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        flexShrink: 1,
    },
    readinessNeedsYou: {
        color: theme.colors.state.warning.foreground,
    },
    readinessBlocked: {
        color: theme.colors.state.danger.foreground,
    },
    readinessQuiet: {
        color: theme.colors.text.secondary,
    },
    readinessAction: {
        flexDirection: 'row',
    },
    progressTrack: {
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        backgroundColor: theme.colors.border.default,
    },
    progressFill: {
        height: '100%',
        borderRadius: 2,
        backgroundColor: theme.colors.text.primary,
    },
    rows: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        paddingVertical: theme.space.s12,
        paddingHorizontal: theme.space.s16,
    },
    rowDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    rowRole: {
        ...Typography.variant('meta', 'semiBold'),
        lineHeight: 20,
        width: 48,
        color: theme.colors.text.secondary,
    },
    rowBody: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    rowWhere: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginLeft: 26,
        color: theme.colors.text.secondary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s12,
        paddingHorizontal: 18,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    rowsSlot: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    footerReadiness: {
        flex: 1,
        marginTop: -6,
    },
    footerText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        flex: 1,
        color: theme.colors.text.secondary,
    },
}));
