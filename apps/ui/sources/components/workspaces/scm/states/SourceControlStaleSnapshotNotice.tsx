import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The shape both git surfaces store for a failed snapshot refresh. Only the presence of the error
 * and its structured code matter here: the raw `message` is transport vocabulary and never reaches
 * this card (`SourceControlUnavailableState` owns the one place a sanitized detail is shown).
 */
export type SourceControlStaleSnapshotError = Readonly<{
    errorCode?: string | null;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: 12,
        marginTop: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        // The banner sits on `surface.inset` neighbours and shares their fill, so this outline is
        // the only thing separating it from the sub-tab header above it. Measured against
        // `surface.inset` with the `themeContrast.test.ts` math: `border.default` is 1.13:1 in both
        // themes and `border.strong` — the obvious next weight — only reaches 1.37:1 light /
        // 1.28:1 dark, against the 3:1 WCAG 1.4.11 asks of a boundary that carries meaning. No
        // border-weight token in this theme clears it. The status role this card already speaks in
        // does: this is literally the warning glyph's own colour, and it measures 3.34:1 light /
        // 6.13:1 dark — and at least 3.34:1 in all 36 built-in theme-profile modes, where
        // `state.danger.border` is often a low-alpha tint that drops to 1.28:1. Asserted for the
        // base themes in `theme/themeContrast.test.ts`.
        borderColor: theme.colors.state.danger.foreground,
        backgroundColor: theme.colors.surface.inset,
    },
    copy: {
        flex: 1,
        gap: 2,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text.primary,
    },
    body: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    hiddenDiagnostic: {
        width: 0,
        height: 0,
    },
}));

/**
 * A source-control surface whose content is real but whose latest refresh failed.
 *
 * `F-SCM-2`: both git surfaces reported a snapshot error ONLY while they had nothing to show
 * (`!snapshot && error`). Neither store clears the snapshot when a refresh fails, so after the
 * first successful read the failure became invisible and stale content — including a stale
 * "not under source control" — read as current.
 *
 * The treatment is the local-services pane's (`local-services-pane-error`): keep the last good
 * content and put a named "needs attention" marker with a retry beside it, because hiding either
 * half is worse than showing both. It deliberately does NOT replace content —
 * {@link SourceControlUnavailableState} still owns the terminal state where there is nothing to
 * keep. Renders nothing when there is no error, so callers can mount it unconditionally.
 */
export function SourceControlStaleSnapshotNotice(props: Readonly<{
    error?: SourceControlStaleSnapshotError | null;
    onRetry?: () => void;
    /**
     * Scopes this notice's markers, including `${testID}-action`. Both git surfaces can be mounted
     * at once, so each passes its own — an unscoped id lets a hidden twin answer for the visible
     * one (the ambiguity L1 removed from the unavailable card).
     */
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (!props.error) return null;

    const errorCode = typeof props.error.errorCode === 'string' && props.error.errorCode.length > 0
        ? props.error.errorCode
        : null;
    const title = t('files.sourceControlStale.title');
    const body = t('files.sourceControlStale.body');

    return (
        <View
            testID={props.testID}
            style={styles.banner}
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
        >
            <Icon name="warning" size={16} color={theme.colors.state.danger.foreground} />
            <View style={styles.copy}>
                <Text testID={`${props.testID}-title`} style={styles.title}>{title}</Text>
                <Text testID={`${props.testID}-reason`} style={styles.body}>{body}</Text>
            </View>
            {props.onRetry ? (
                <ToolbarButton
                    testID={`${props.testID}-action`}
                    size="md"
                    label={t('common.retry')}
                    accessibilityLabel={t('common.retry')}
                    onPress={props.onRetry}
                />
            ) : null}
            {errorCode ? (
                // Diagnostics-only channel, matching `SurfaceStateCard`: the raw code is reachable
                // for QA through a testID and never rendered or announced.
                <View
                    testID={`${props.testID}-diagnostic-${errorCode}`}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.hiddenDiagnostic}
                />
            ) : null}
        </View>
    );
}
