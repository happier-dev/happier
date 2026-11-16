import { HAPPIER_FRESHNESS_LINE_METRICS, HappierBanner, HappierPressable, happierPageTextMetrics, type HappierBannerPoint } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { HAPPIER_PAGE_METRICS, readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { RoundButton, type RoundButtonDisplay } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { usePageListInsets } from '@/components/ui/lists/listPresentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type AttentionBannerAction = Readonly<{
    label: string;
    onPress: () => void;
    testID?: string;
    disabled?: boolean;
    loading?: boolean;
    display?: RoundButtonDisplay;
    /** A glyph before the label (Try again's arrows), for the band's one recovery button. */
    icon?: IconName;
}>;

/**
 * The one tinted notice a page shows above the content it concerns: something blocks use
 * (`warning`: offline, needs sign-in) or waits on someone (`neutral`: an approval, a read-only
 * archive). It names the state and carries the next action; healthy pages never render it.
 *
 * Its own surface, not a sheet: a quiet tint of the tone with the tone's hairline on every edge, the
 * tone's glyph in the rows' icon column, the title and description on the rows' text steps, and the
 * action on the right — beneath the text when the banner is too narrow for both. It takes a section's
 * place in the page flow (one section gap above it, on the sheets' edges).
 *
 * `presentation="strip"` is the same notice as the compact band across the top of a pane or reading
 * surface (Walkthrough lab `wk-band`), drawn by the shared banner's strip: the title leads when a
 * description finishes the sentence (a failure's title always leads: it names the fact first), the second ways forward are words and the action is the band's one
 * button at its end. A strip that fails is announced as an alert; any other is a polite status.
 */
export const AttentionBanner = React.memo(function AttentionBanner(props: Readonly<{
    testID: string;
    title: string;
    description?: string;
    /**
     * Checks or steps the reader can take, beneath the description: one hanging line each, so a long
     * point wraps under its own text rather than under the bullet.
     */
    points?: readonly HappierBannerPoint[];
    tone?: 'warning' | 'neutral' | 'danger';
    /** A containing pane can own its gutter; page sections retain the shared section insets. */
    placement?: 'page-section' | 'inline';
    /** A domain-specific status mark, still rendered through the shared banner slot. */
    icon?: React.ReactNode;
    action?: AttentionBannerAction | null;
    /**
     * The primary way forward when it is a shared control rather than a button (the agent-action split button,
     * `AgentActionButton`): drawn in the action's place, so a notice never grows a second actions row.
     */
    control?: React.ReactNode;
    /**
     * A notice whose sibling states differ in how many ways forward they offer keeps its actions in one
     * place: `below` puts even a single action under the words, where two or more always sit.
     */
    actionPlacement?: 'below';
    compactActionPlacement?: 'full-width';
    /** A second way forward (open the page that fixes it), beside the action. */
    secondaryAction?: AttentionBannerAction | null;
    /** Rare further ways forward, after the second (a conflict's Skip beside Abort). Quiet, same button step. */
    moreActions?: readonly AttentionBannerAction[];
    /**
     * Technical facts for support or an expert (raw errors, codes). Hidden behind "Details" so the
     * notice itself speaks in outcomes.
     */
    details?: readonly string[];
    accessibilityLiveRegion?: 'polite' | 'assertive';
    /**
     * A failure the reader must hear now (a refresh that failed over cached data) is an alert; a notice that appears
     * in place within a pane (a walkthrough's uncertain start) is a polite status. Cards are silent by default.
     */
    announce?: 'alert' | 'status';
    /** The notice can be put away (an operation's failure the reader has seen): a quiet × at its end. */
    onDismiss?: () => void;
    presentation?: 'card' | 'strip';
    /** The tone's glyph unless the notice names its own state ("x-circle" failed, "path" rewritten). */
    iconName?: IconName;
}>) {
    if (props.presentation === 'strip') return <AttentionBannerStrip {...props} />;
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const textStyles = attentionBannerTextStyles;
    const tone = props.tone ?? 'warning';
    const palette = theme.colors.state[tone];
    const iconName: IconName = props.iconName ?? (tone === 'neutral' ? 'info' : 'warning');
    const presentationTheme = usePluginUiTheme(theme);
    const contained = usePageListInsets() === 'contained';
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const [compact, setCompact] = React.useState(false);
    const fullWidthAction = compact && props.compactActionPlacement === 'full-width';
    const toggleDetails = React.useCallback(() => setDetailsOpen((open) => !open), []);
    const hasDetails = (props.details?.length ?? 0) > 0;
    // Beside a shared control (a split button drawn at the plugin-ui small height), the banner's own buttons match it.
    const besideControl = props.control !== undefined && props.control !== null;
    // The one filled button leads the row: a filled banner action goes before the shared control, which then yields.
    const actionLeads = props.action?.display === 'default';
    const actionButton = props.action
        ? <BannerButton action={props.action} testID={`${props.testID}.action`} fullWidth={fullWidthAction} beside={besideControl} />
        : null;
    const actions = props.action || props.control || props.secondaryAction || (props.moreActions?.length ?? 0) > 0 ? (
        // Narrow, the ways forward move beneath one another at one width instead of wrapping ragged.
        <View style={[styles.actions, compact ? styles.actionsStacked : null, fullWidthAction ? { width: '100%' } : null]}>
            {actionLeads ? actionButton : null}
            {props.control ?? null}
            {actionLeads ? null : actionButton}
            {props.secondaryAction
                ? <BannerButton action={props.secondaryAction} testID={`${props.testID}.secondaryAction`} quiet beside={besideControl} />
                : null}
            {(props.moreActions ?? []).map((more, index) => (
                <BannerButton key={index} action={more} testID={`${props.testID}.moreAction.${index}`} quiet beside={besideControl} />
            ))}
        </View>
    ) : null;
    const banner = (
            <HappierBanner
                testID={props.testID}
                title={props.title}
                description={props.description}
                tone={tone}
                theme={presentationTheme}
                backgroundColor={palette.background}
                borderColor={palette.border}
                announce={props.announce ?? 'none'}
                accessibilityLiveRegion={props.accessibilityLiveRegion}
                icon={props.icon ?? <Icon name={iconName} size={ICON_SIZE.md} color={palette.foreground} />}
                titleContent={<Text style={textStyles.title}>{props.title}</Text>}
                descriptionContent={props.description ? <Text style={textStyles.description}>{props.description}</Text> : undefined}
                points={props.points}
                renderPoint={(point, index) => (
                    <Text style={[textStyles.description, styles.pointText]}>
                        {point.map((segment, segmentIndex) => typeof segment === 'string' ? segment : (
                            <Text key={segmentIndex} testID={`${props.testID}.point.${index}.code.${point.slice(0, segmentIndex).filter((part) => typeof part !== 'string').length}`}
                                // A command never breaks inside itself; the line wraps around it.
                                style={styles.code}>{segment.code.replace(/ /g, '\u00a0')}</Text>
                        ))}
                    </Text>
                )}
                action={actions}
                compactActionPlacement={props.compactActionPlacement}
                // Two or more ways forward (a shared control counts as one), or a list of steps, never share a line with the words.
                actionPlacement={props.actionPlacement ?? (props.secondaryAction || (props.moreActions?.length ?? 0) > 0
                    || (besideControl && props.action) ? 'below' : undefined)}
                onLayout={(event) => { const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width); if (width !== null) setCompact(width < PAGE_LIST_METRICS.rowStackBelowWidthPx); }}
                details={<>
                    {hasDetails ? (
                        <HappierPressable
                            testID={`${props.testID}.details`}
                            accessibilityRole="button"
                            expanded={detailsOpen}
                            onPress={toggleDetails}
                            style={styles.detailsToggle}
                        >
                            <Text style={styles.detailsToggleText}>{t('common.details')}</Text>
                            <DisclosureCaret expanded={detailsOpen} size={ICON_SIZE.xs} />
                        </HappierPressable>
                    ) : null}
                    {hasDetails && detailsOpen ? (
                        <View testID={`${props.testID}.detailsContent`} style={styles.detailsContent}>
                            {props.details!.map((line, index) => (
                                <Text key={index} selectable style={styles.detailsLine}>{line}</Text>
                            ))}
                        </View>
                    ) : null}
                </>}
                dismiss={props.onDismiss ? (
                        <IconButton
                            testID={`${props.testID}.dismiss`}
                            variant="plain"
                            size={28}
                            accessibilityLabel={t('common.close')}
                            icon={<Icon name="x" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                            onPress={props.onDismiss}
                        />
                ) : undefined}
            />
    );
    // A banner is a box with its own edge, not a bare row: in a contained scope it stays on the column instead of bleeding into
    // its padding, and on a page it keeps the sheets' inset, so its edge is theirs.
    // The notice is an Element: over an atmosphere band or wallpaper its tint needs the Elements backing beneath it, or
    // the art shows through its words (DESIGN.md, "Elements need a backing"). Over a plain page the backing is the card's solid paint.
    const backed = <GlassSurface surfaceGroup="card" nested finishRole={null} style={styles.backing}>{banner}</GlassSurface>;
    return props.placement === 'inline' ? backed : <ItemGroup surface="none" containerStyle={contained ? styles.column : undefined}>{backed}</ItemGroup>;
});

function AttentionBannerStrip(props: React.ComponentProps<typeof AttentionBanner>) {
    const { theme } = useUnistyles();
    const tone = props.tone ?? 'warning';
    const palette = theme.colors.state[tone];
    const presentationTheme = usePluginUiTheme(theme);
    const links = [...(props.secondaryAction ? [{ action: props.secondaryAction, testID: `${props.testID}.secondaryAction` }] : []),
        ...(props.moreActions ?? []).map((action, index) => ({ action, testID: `${props.testID}.moreAction.${index}` }))];
    const hasActions = Boolean(props.action) || Boolean(props.control) || links.length > 0;
    return (
        <HappierBanner
            presentation="strip"
            testID={props.testID}
            title={props.title}
            description={props.description}
            tone={tone}
            theme={presentationTheme}
            backgroundColor={tone === 'neutral' ? theme.colors.surface.inset : palette.background}
            borderColor={theme.colors.border.default}
            announce={props.announce ?? (tone === 'danger' ? 'alert' : 'status')}
            accessibilityLiveRegion={props.accessibilityLiveRegion}
            icon={props.icon ?? <Icon name={props.iconName ?? (tone === 'neutral' ? 'info' : tone === 'danger' ? 'x-circle' : 'warning')}
                size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx} color={tone === 'neutral' ? theme.colors.text.tertiary : palette.foreground} />}
            titleContent={(
                <Text style={stripStyles.text}>
                    {props.description || tone === 'danger' ? <Text style={stripStyles.lead}>{props.title}</Text> : props.title}
                    {props.description ? ` ${props.description}` : null}
                </Text>
            )}
            action={hasActions ? (
                <>
                    {/* A text link keeps to the start of its line (it ends sentences); its own box centres it
                        on the strip's action row beside the bordered button instead of riding high. */}
                    {links.map(({ action, testID }) => (
                        <View key={testID}>
                            <TextLinkButton testID={action.testID ?? testID} tone="strong" size="meta"
                                label={action.label} onPress={action.onPress} disabled={action.disabled} />
                        </View>
                    ))}
                    {props.control ?? null}
                    {props.action ? <BannerButton action={props.action} testID={`${props.testID}.action`} /> : null}
                </>
            ) : undefined}
            details={props.details?.length ? (
                <View testID={`${props.testID}.detailsContent`}>
                    {props.details.map((line, index) => <Text key={index} selectable style={stripStyles.detail}>{line}</Text>)}
                </View>
            ) : undefined}
            dismiss={props.onDismiss ? (
                <IconButton testID={`${props.testID}.dismiss`} variant="plain" size={28} accessibilityLabel={t('common.close')}
                    icon={<Icon name="x" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />} onPress={props.onDismiss} />
            ) : undefined}
        />
    );
}

function BannerButton(props: Readonly<{ action: AttentionBannerAction; testID: string; quiet?: boolean; fullWidth?: boolean; beside?: boolean }>) {
    const { theme } = useUnistyles();
    return (
        <RoundButton
            testID={props.action.testID ?? props.testID}
            size={props.fullWidth ? 'normal' : props.beside ? 'small' : 'mini'}
            style={props.fullWidth ? { width: '100%' } : undefined}
            display={props.action.display ?? (props.quiet ? 'inverted' : 'secondary')}
            title={props.action.label}
            leading={props.action.icon ? <Icon name={props.action.icon} size={ICON_SIZE.xs}
                color={props.action.display === 'default' ? theme.colors.button.primary.tint : theme.colors.text.primary} /> : undefined}
            textStyle={props.quiet ? Typography.default() : undefined}
            disabled={props.action.disabled}
            loading={props.action.loading}
            onPress={props.action.onPress}
        />
    );
}

/** The banner's title and description text, for a host notice composed on the same shared banner. */
export const attentionBannerTextStyles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s2,
    },
}));

const stripStyles = StyleSheet.create((theme) => ({
    text: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    lead: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.primary },
    detail: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
}));

const stylesheet = StyleSheet.create((theme) => ({
    column: { marginHorizontal: 0 },
    backing: { borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    actionsStacked: {
        flexDirection: 'column',
        alignItems: 'stretch',
        alignSelf: 'stretch',
    },
    pointText: {
        flex: 1,
        minWidth: 0,
        marginTop: 0,
    },
    code: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
    },
    detailsToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s4,
        marginTop: theme.space.s6,
    },
    detailsToggleText: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    detailsContent: {
        marginTop: theme.space.s6,
        gap: theme.space.s2,
    },
    detailsLine: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
}));
