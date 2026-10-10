import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { PaneHeader, type PaneHeaderLineSegment } from '@/components/appShell/panes/PaneHeader';
import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { DETAILS_TAB_HEADER_METRICS } from './detailsTabHeaderMetrics';

/**
 * One fact on the header's live line, in reading order. `strong` is the one noun the line is about
 * (a branch, an author); a `diffStat` reads as one fact (`+4 −2`).
 */
export type DetailsTabHeaderMetaFact =
    | Readonly<{ key: string; kind?: 'text'; text: string; tone?: 'default' | 'muted' | 'strong' | 'mono'; shrink?: boolean; testID?: string }>
    | Readonly<{ key: string; kind: 'diffStat'; added: number; removed: number; testID?: string }>;

export type DetailsTabHeaderAction = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    /** `primary` is the surface's one filled action (Save, Restore); `default` a quiet bordered one (Stage). */
    tone?: 'primary' | 'default' | 'danger';
    accessibilityLabel?: string;
    testID?: string;
}>;

export type DetailsTabHeaderProps = Readonly<{
    /** The thing this tab shows, in its own words: the file name, the commit subject, the stash as a place. */
    title: string;
    leading?: React.ReactNode;
    titleControl?: React.ReactNode;
    titleTextStyle?: React.ComponentProps<typeof PaneHeader>['titleTextStyle'];
    meta?: readonly DetailsTabHeaderMetaFact[];
    /** A live status or presence leaf; its own subscription keeps ticking out of the header owner. */
    metaLeading?: React.ReactNode;
    metaTrailing?: React.ReactNode;
    /** A short paragraph under the header (a commit body, what Restore will do). */
    body?: React.ReactNode;
    /** Quiet controls in the header band (icon toggles), before the buttons. */
    actions?: React.ReactNode;
    /** The surface's actions, in order; at most one is `primary`. */
    buttons?: readonly DetailsTabHeaderAction[];
    /** Rare operations behind `⋯`. */
    menuActions?: readonly PageHeaderMenuAction[];
    /** A domain menu with richer facts (Run details), still placed by this header's phone policy. */
    menu?: React.ReactNode;
    /** Controls that shape the view (Diff | File, Unstaged ▾, a stash switcher), on one thin row under the band. */
    controls?: React.ReactNode;
    /** One line under the header (freshness, the file changed under an edit). */
    notice?: React.ReactNode;
    testID?: string;
}>;

function toLineSegments(meta: readonly DetailsTabHeaderMetaFact[] | undefined): PaneHeaderLineSegment[] {
    const segments: PaneHeaderLineSegment[] = [];
    for (const fact of meta ?? []) {
        if (fact.kind === 'diffStat') {
            if (fact.added > 0 || fact.removed === 0) segments.push({ text: `+${fact.added}`, tone: 'added' });
            if (fact.removed > 0) segments.push({ text: `−${fact.removed}`, tone: 'removed' });
            continue;
        }
        segments.push(fact.tone === 'strong' ? { text: fact.text, emphasis: true } : fact.text);
    }
    return segments;
}

/**
 * The header of a Details tab: a Details adapter over the one pane header (`PaneHeader`). The band
 * names the thing (title), places it (the live line: path, who, when, how much) and carries what it
 * is for (quiet toggles, the buttons, `⋯`). Only what is Details' own sits beneath it — one thin row of
 * view controls, an optional body, one notice line — so a header never eats the code's height.
 *
 * On a phone the band takes the pane header's large step and the controls stay on their own row.
 */
export const DetailsTabHeader = React.memo(function DetailsTabHeader(props: DetailsTabHeaderProps) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const phone = useSurfaceStateSize() === 'phone';
    const metrics = DETAILS_TAB_HEADER_METRICS[phone ? 'phone' : 'pane'];
    const styles = stylesheet;
    const testID = props.testID ?? 'details-tab-header';
    const segments = React.useMemo(() => toLineSegments(props.meta), [props.meta]);

    const buttons = props.buttons && props.buttons.length > 0 ? props.buttons.map((button) => (
        <ToolbarButton
            key={button.testID ?? button.label}
            testID={button.testID}
            label={button.label}
            accessibilityLabel={button.accessibilityLabel}
            onPress={button.disabled || button.busy ? undefined : button.onPress}
            disabled={button.disabled || button.busy}
            busy={button.busy}
            tone={button.tone ?? 'default'}
            size={phone ? 'md' : 'sm'}
        />
    )) : null;
    const menu = props.menu ?? (props.menuActions && props.menuActions.length > 0 ? (
        <PageHeaderMenu testID={`${testID}.menu`} actions={props.menuActions} />
    ) : null);
    // The pane's own controls (⤢, close), when the pane showing this tab has no bar of its own.
    const paneControls = useClaimedStackHeaderActions({ scopeOnly: true });
    // A phone recomposes: only `⋯` stays beside the title; the toggles and buttons move beneath it.
    const bandActions = phone
        ? (menu ?? undefined)
        : props.actions || buttons || menu || paneControls ? (
            <View style={styles.bandActions}>
                {props.actions}
                {buttons}
                {menu}
                {paneControls}
            </View>
        ) : undefined;
    const phoneToolbar = phone && (props.controls || props.actions || buttons || paneControls) ? (
        <View style={styles.controls}>
            {props.controls}
            <View style={styles.grow} />
            {props.actions}
            {buttons}
            {paneControls}
        </View>
    ) : null;

    return (
        <View testID={`${testID}.root`} style={[styles.root, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            <PaneHeader
                testID={testID}
                title={props.title}
                leading={props.leading}
                titleControl={props.titleControl}
                titleTextStyle={props.titleTextStyle}
                titleNumberOfLines={phone ? null : 1}
                lineTrailing={!phone ? props.controls : undefined}
                lineEnd={props.metaTrailing}
                line={segments.length > 0 || props.metaLeading ? {
                    segments,
                    leading: props.metaLeading ? <View style={styles.liveFacts}>
                        {props.metaLeading}
                        {segments.length > 0 ? <Text style={[styles.metaSeparator, metrics.meta]}>·</Text> : null}
                    </View> : undefined,
                } : null}
                actions={bandActions}
                size={phone ? 'large' : 'band'}
            />
            {props.body || phoneToolbar ? (
                <View style={[styles.below, { paddingLeft: metrics.paddingStartPx, paddingRight: metrics.paddingEndPx }]}>
                    {phoneToolbar}
                    {props.body ? (
                        typeof props.body === 'string'
                            ? <Text testID={`${testID}.body`} style={[styles.body, metrics.body]}>{props.body}</Text>
                            : props.body
                    ) : null}
                </View>
            ) : null}
            {props.notice ?? null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
    bandActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    liveFacts: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: 4,
    },
    metaSeparator: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    below: {
        gap: 4,
        paddingBottom: 6,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    grow: {
        flex: 1,
    },
    body: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        maxWidth: 560,
    },
}));
