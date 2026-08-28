import * as React from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export type SurfaceStateKind = 'empty' | 'loading' | 'error' | 'warning' | 'unavailable';
export type SurfaceStateAccessibilitySemantics = 'status' | 'alert';

export type SurfaceStateAction = Readonly<{
    /** Already-translated action label. */
    label: string;
    onPress: () => void | Promise<unknown>;
}>;

const DEFAULT_ICONS: Record<Exclude<SurfaceStateKind, 'loading'>, IconName> = {
    empty: 'tray',
    error: 'warning-circle',
    warning: 'warning-circle',
    unavailable: 'cloud-slash',
};

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
    },
    card: {
        maxWidth: 560,
        alignSelf: 'center',
    },
    actions: {
        flexDirection: 'row',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'center',
    },
    detail: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        opacity: 0.9,
        marginTop: -10,
    },
    hiddenDiagnostic: {
        width: 0,
        height: 0,
    },
    iconWrap: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * The ONE shared terminal-state card for surface panes (audit XS-3): unifies
 * the bespoke unavailable / empty / error / loading states across browser,
 * simulator, local-services, and plugin surfaces. Composes the canonical
 * {@link EmptyState} tile (icon + title + copy + action slot).
 *
 * i18n is the caller's responsibility: `title` and `reason` are
 * already-translated HUMAN copy (route reason codes through
 * `resolveReasonCopy` first). The raw machine code goes on `diagnosticCode`,
 * which is exposed ONLY through a testID marker for QA/diagnostics — it never
 * reaches visible text or accessibility labels.
 */
export function SurfaceStateCard(props: Readonly<{
    testID?: string;
    kind: SurfaceStateKind;
    /** Already-translated title. */
    title: string;
    /** Already-translated human explanation (never a raw reason code). */
    reason?: string;
    /** Raw machine reason code — testID diagnostics channel only. */
    diagnosticCode?: string | null;
    /** Optional sanitized supplemental detail. Never pass a raw machine code. */
    detail?: string;
    /** Primary next step (retry, open, rescan…). */
    action?: SurfaceStateAction;
    secondaryAction?: SurfaceStateAction;
    /** Caller-owned glyph when a surface has a domain-specific icon. */
    icon?: React.ReactNode;
    /** Override the per-kind default glyph. */
    iconName?: IconName;
    animationEnabled?: boolean;
    /** Opts this dynamic state into one live-region owner; static cards stay silent by default. */
    accessibilitySemantics?: SurfaceStateAccessibilitySemantics;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const tint = props.kind === 'error'
        ? theme.colors.state.danger.foreground
        : props.kind === 'warning'
            ? theme.colors.state.warning.foreground
        : theme.colors.text.secondary;
    const accessibilityLiveRegion = props.accessibilitySemantics === 'alert'
        ? 'assertive'
        : props.accessibilitySemantics === 'status'
            ? 'polite'
            : undefined;
    const accessibilityAnnouncement = [props.title, props.reason, props.detail]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value))
        .join('. ');
    const lastIosAnnouncementRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'ios' || !props.accessibilitySemantics) return;
        const transitionKey = `${props.accessibilitySemantics}\u0000${accessibilityAnnouncement}`;
        if (lastIosAnnouncementRef.current === transitionKey) return;
        lastIosAnnouncementRef.current = transitionKey;
        try {
            AccessibilityInfo.announceForAccessibility(accessibilityAnnouncement);
        } catch {
            // Accessibility announcements are best effort on native platforms.
        }
    }, [accessibilityAnnouncement, props.accessibilitySemantics]);

    const icon = props.kind === 'loading' ? (
        <ActivitySpinner
            testID={props.testID ? `${props.testID}-loading-spinner` : undefined}
            size={28}
            color={theme.colors.text.secondary}
            animationEnabled={props.animationEnabled !== false}
        />
    ) : props.icon ?? (
        <Icon
            name={props.iconName ?? DEFAULT_ICONS[props.kind]}
            size={32}
            color={tint}
        />
    );

    return (
        <View
            testID={props.testID}
            style={styles.root}
            accessibilityRole={props.accessibilitySemantics === 'alert'
                ? 'alert'
                : props.accessibilitySemantics === 'status'
                    ? 'text'
                    : undefined}
            accessibilityLiveRegion={accessibilityLiveRegion}
            {...(props.accessibilitySemantics ? ({
                role: props.accessibilitySemantics,
                'aria-live': accessibilityLiveRegion,
            } as Record<string, unknown>) : {})}
        >
            <SurfaceCard
                testID={props.testID ? `${props.testID}-card` : undefined}
                tone="muted"
                padding="lg"
                style={styles.card}
            >
                <EmptyState
                    icon={(
                        <View
                            testID={props.testID ? `${props.testID}-icon` : undefined}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={styles.iconWrap}
                        >
                            {icon}
                        </View>
                    )}
                    title={props.title}
                    subtitle={props.reason}
                    titleTestID={props.testID ? `${props.testID}-title` : undefined}
                    subtitleTestID={props.testID && props.reason != null ? `${props.testID}-reason` : undefined}
                    action={props.action || props.secondaryAction ? (
                        <View style={styles.actions}>
                            {props.action ? (
                                <RoundButton
                                    testID={props.testID ? `${props.testID}-action` : undefined}
                                    size="small"
                                    title={props.action.label}
                                    accessibilityLabel={props.action.label}
                                    onPress={() => { void props.action?.onPress(); }}
                                />
                            ) : null}
                            {props.secondaryAction ? (
                                <RoundButton
                                    testID={props.testID ? `${props.testID}-secondary-action` : undefined}
                                    size="small"
                                    display="inverted"
                                    title={props.secondaryAction.label}
                                    accessibilityLabel={props.secondaryAction.label}
                                    onPress={() => { void props.secondaryAction?.onPress(); }}
                                />
                            ) : null}
                        </View>
                    ) : undefined}
                />
                {props.detail ? (
                    <Text
                        testID={props.testID ? `${props.testID}-detail` : undefined}
                        style={styles.detail}
                    >
                        {props.detail}
                    </Text>
                ) : null}
                {props.diagnosticCode ? (
                    // Diagnostics-only channel: the raw code is reachable for QA via
                    // testID, never rendered as text or announced to screen readers.
                    <View
                        testID={props.testID ? `${props.testID}-diagnostic-${props.diagnosticCode}` : undefined}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={styles.hiddenDiagnostic}
                    />
                ) : null}
            </SurfaceCard>
        </View>
    );
}
