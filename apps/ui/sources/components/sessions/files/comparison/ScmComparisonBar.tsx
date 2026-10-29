import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { useHardwareKeyboard } from '@/components/ui/selectionList/useHardwareKeyboard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { KeyboardShortcutLabelsContext, splitKeybindingLabel } from '@/keyboard/shortcutLabels';
import type { KeyboardCommandId } from '@/keyboard/types';

/**
 * The one bar over a comparison (Walkthrough lab WT1/WT8): the view switch and scope on the left, the
 * comparison's actions on the right. Files and Walkthrough draw the same bar, so switching views keeps
 * every control where it was.
 */
export function ScmComparisonBar(props: Readonly<{ leading: React.ReactNode; trailing?: React.ReactNode; children?: React.ReactNode }>) {
    return (
        <View testID="scm-comparison-bar" style={styles.bar}>
            <View style={styles.leading}>{props.leading}</View>
            {props.trailing ? <View style={styles.trailing}>{props.trailing}</View> : null}
            {props.children}
        </View>
    );
}

/** The wide review entry, including the same in-place reason the phone action menu carries. */
export function ScmComparisonStartReview(props: Readonly<{ onPress: () => void; disabled?: boolean; disabledReason?: string | null }>) {
    const { theme } = useUnistyles();
    return <View style={styles.reviewAction}>
        {/* The reason sits on the bar's own line, before the action it explains: a second line under the button made the bar two rows tall. */}
        {props.disabledReason ? <Text testID="scm-comparison-review-reason" numberOfLines={1} style={styles.reviewReason}>{props.disabledReason}</Text> : null}
        <RoundButton testID="scm-comparison-start-review" size="small" display="secondary"
            title={t('scmComparison.startReview')} disabled={props.disabled}
            accessibilityHint={props.disabledReason ?? undefined} onPress={props.onPress}
            leading={<Icon name="shield-check" size={ICON_SIZE.xs} color={theme.colors.text.primary} />} />
    </View>;
}

/** The quiet way into a commit proposal for pending changes, beside Start review on every host. */
export function ScmComparisonProposeCommits(props: Readonly<{ onPress: () => void }>) {
    const { theme } = useUnistyles();
    return <RoundButton testID="scm-comparison-propose-commits" size="small" display="inverted"
        title={t('scmComparison.proposeCommits')} onPress={props.onPress}
        leading={<Icon name="git-commit" size={ICON_SIZE.xs} color={theme.colors.text.primary} />} />;
}

/** Files | Walkthrough over one comparison; Commits joins only where the owner offers it. */
export function ScmComparisonViewSwitch(props: Readonly<{
    view: SessionScmReviewView;
    views: readonly SessionScmReviewView[];
    onSelect: (view: SessionScmReviewView) => void;
    /** How many commits the pending proposal holds ("Commits 3"); absent before one exists. */
    commitsCount?: number | null;
}>) {
    const tabs = React.useMemo(() => props.views.map((view) => ({
        id: view,
        label: view === 'files' ? t('scmComparison.view.files') : view === 'walkthrough' ? t('scmComparison.view.walkthrough')
            : props.commitsCount ? `${t('scmComparison.view.commits')} ${props.commitsCount}` : t('scmComparison.view.commits'),
    })), [props.commitsCount, props.views]);
    // Each view draws its own bar, so choosing a view by keyboard remounts the switch and the tab the
    // segmented bar just focused leaves the document. The switch carries "the person was here" across
    // that remount and puts focus on the newly active tab, so Arrow keys keep working without re-tabbing.
    const rowRef = React.useRef<View>(null);
    const { onSelect } = props;
    const onSelectTab = React.useCallback((view: SessionScmReviewView) => {
        const row = webElementOf(rowRef.current);
        carriedSwitchFocus = row && typeof document !== 'undefined' && row.contains(document.activeElement) ? view : null;
        onSelect(view);
    }, [onSelect]);
    React.useEffect(() => {
        if (carriedSwitchFocus !== props.view) return;
        carriedSwitchFocus = null;
        const row = webElementOf(rowRef.current);
        if (!row || row.contains(document.activeElement)) return;
        row.querySelector<HTMLElement>(`[data-testid="scm-comparison-view:${props.view}"]`)?.focus();
    }, [props.view]);
    return (
        <View ref={rowRef} style={styles.switchRow}>
            <SegmentedTabBar
                testIDPrefix="scm-comparison-view"
                tabs={tabs}
                activeTabId={props.view}
                onSelectTab={onSelectTab}
                segmentSizing="content"
                accessibilityLabel={t('scmComparison.viewA11y')}
            />
            <View style={styles.divider} />
        </View>
    );
}

/** The view a keyboard choice moved to while focus sat in a switch; read once by the switch that mounts for it. */
let carriedSwitchFocus: SessionScmReviewView | null = null;

function webElementOf(node: View | null): HTMLElement | null {
    if (Platform.OS !== 'web' || typeof HTMLElement === 'undefined') return null;
    return node instanceof HTMLElement ? node : null;
}

/** Files' Explain: the walkthrough's own notes beside the hunks they explain (lab WT8-F2; key E). */
export function ScmComparisonExplainToggle(props: Readonly<{ value: boolean; onChange: (next: boolean) => void }>) {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID="scm-comparison-explain"
            accessibilityRole="switch"
            checked={props.value}
            accessibilityLabel={t('scmComparison.explainA11y')}
            onPress={() => props.onChange(!props.value)}
            style={(state) => [
                styles.explain,
                props.value ? styles.explainOn : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Icon name="path" size={ICON_SIZE.sm} color={props.value ? theme.colors.accent.blue : theme.colors.text.secondary} />
            <Text style={styles.explainLabel}>{t('scmComparison.explain')}</Text>
            <View pointerEvents="none">
                <Switch value={props.value} onValueChange={props.onChange} accessibilityElementsHidden importantForAccessibility="no" />
            </View>
        </HappierPressable>
    );
}

/** A comparison rail's horizontal inset (Files' changed files, Walkthrough's contents): rows sit inside it. */
export const SCM_COMPARISON_RAIL_INSET_PX = 8;

/**
 * The caption heading a comparison rail ("Changed files 9" with the list | tree switch, "Contents 2 of 5
 * reviewed"). Both views draw this one row at one height, so switching Files and Walkthrough keeps the
 * caption, its count and the rail's first row exactly where they were.
 */
export function ScmComparisonRailCaption(props: Readonly<{
    title: string;
    count?: string | null;
    countTestID?: string;
    /** Right after the title (Files: the file count) instead of at the end (Walkthrough: progress). */
    countPlacement?: 'leading' | 'trailing';
    trailing?: React.ReactNode;
}>) {
    const count = props.count ? <Text testID={props.countTestID} style={styles.railCount}>{props.count}</Text> : null;
    return (
        <View style={styles.railCaption}>
            <Text style={styles.railTitle}>{props.title}</Text>
            {props.countPlacement === 'leading' ? count : null}
            <View style={styles.grow} />
            {props.countPlacement === 'leading' ? null : count}
            {props.trailing}
        </View>
    );
}

/**
 * The rail's foot: the keys this view binds (web only; the caller decides availability). Each hint names
 * the commands it advertises and shows their keys as bound here; a command nothing runs (keyboard
 * shortcuts or single-key shortcuts off) draws no hint.
 */
export function ScmComparisonRailKeys(props: Readonly<{ testID?: string; keys: readonly Readonly<{ commands: readonly KeyboardCommandId[]; label: string }>[] }>) {
    const labels = React.useContext(KeyboardShortcutLabelsContext);
    // Keycaps name keys: on a touch screen they are not at hand, as for every other key hint.
    const hasKeyboard = useHardwareKeyboard();
    const entries = !hasKeyboard ? [] : props.keys.flatMap((entry) => {
        const keycaps = railKeycaps(entry.commands.map((command) => labels[command]));
        return keycaps ? [{ label: entry.label, keycaps }] : [];
    });
    if (entries.length === 0) return null;
    return (
        <View testID={props.testID} style={styles.railKeys}>
            {entries.map((entry) => (
                <View key={entry.label} style={styles.railKey}>
                    {entry.keycaps.map((key, index) => <KeyHint key={index} label={key} />)}
                    <Text style={styles.railKeyLabel}>{entry.label}</Text>
                </View>
            ))}
        </View>
    );
}

/** "Shift+J" and "Shift+K" read as Shift J K; null when any command has no key. */
function railKeycaps(bound: readonly (string | undefined)[]): readonly string[] | null {
    if (bound.length === 0 || bound.some((label) => label === undefined)) return null;
    const parts = bound.map((label) => splitKeybindingLabel(label!));
    const modifiers = parts[0]!.slice(0, -1);
    const shared = parts.every((keys) => keys.slice(0, -1).join('+') === modifiers.join('+'));
    return shared ? [...modifiers, ...parts.map((keys) => keys[keys.length - 1]!)] : parts.flat();
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
        rowGap: theme.space.s4,
        minHeight: 48,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s6,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
    },
    leading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    reviewAction: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 1, minWidth: 0 },
    reviewReason: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1, minWidth: 0,  },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    divider: { width: 1, height: 16, backgroundColor: theme.colors.border.default },
    explain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        height: 36,
        paddingLeft: theme.space.s10,
        paddingRight: theme.space.s6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    explainOn: { borderColor: theme.colors.accent.blue },
    explainLabel: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary,  },
    grow: { flex: 1 },
    railCaption: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minHeight: 28, paddingLeft: theme.space.s12, paddingRight: theme.space.s4, marginBottom: theme.space.s6 },
    railTitle: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary,  },
    railCount: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'],  },
    railKeys: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s12, rowGap: theme.space.s6, paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s12 },
    railKey: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    railKeyLabel: { ...Typography.variant('meta'), color: theme.colors.text.tertiary,  },
}));
