import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalSessionScreenTestId } from '@/components/sessions/shell/sessionScreenTestIds';
import { Icon } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { SessionWorkStripPopoverContent } from './SessionWorkStripPopover';
import type { WorkSummary } from './workProjection';

/**
 * The header's in-row work strip (ORC §3.8, lab `session-C`): "3 still working · 1 needs you".
 *
 * It exists exactly while the lead has outstanding work, and it reads only the Work projection's
 * summary — a handful of numbers — so the always-mounted header never subscribes to a row. Pressing it
 * opens the map popover (lab `session-C`), the one leaf that reads rows, with "Open in sidebar". The lead itself stays neutral (S-6): the needs-you count
 * speaks in the shared attention word treatment, never as a tint on the lead.
 */

const stylesheet = StyleSheet.create((theme) => ({
    strip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 32,
        maxWidth: 280,
        marginRight: 4,
        paddingLeft: 10,
        paddingRight: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'transparent',
        backgroundColor: theme.colors.surface.elevated,
    },
    text: {
        ...Typography.default(),
        ...Typography.tabular(),
        flexShrink: 1,
        color: theme.colors.text.primary,
        fontSize: 12.5,
        lineHeight: 16,
    },
    separator: {
        color: theme.colors.text.tertiary,
    },
}));

export const SessionHeaderWorkStrip = React.memo((props: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
    summary: WorkSummary;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const testId = useOptionalSessionScreenTestId('session-header-work-strip');
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    const onPress = React.useCallback(() => setOpen((current) => !current), []);
    const openInSidebar = React.useCallback(() => {
        setOpen(false);
        pane.openRight({ tabId: 'agents' });
        pane.setRightTab('agents');
    }, [pane]);

    const { outstanding, needsYou } = props.summary;
    if (outstanding <= 0) return null;

    const working = t('sessionWork.strip.stillWorking', { count: outstanding });
    const attention = needsYou > 0 ? t('sessionWork.strip.needsYou', { count: needsYou }) : null;

    return (<>
        <View ref={anchorRef} collapsable={false}>
        <HappierPressable
            testID={testId}
            expanded={open}
            hasPopup="dialog"
            accessibilityRole="button"
            accessibilityLabel={t('sessionWork.strip.a11y', {
                summary: attention ? `${working}, ${attention}` : working,
            })}
            onPress={onPress}
            style={({ focused, pressed }) => [
                styles.strip,
                focusRingStyle({ focused, color: theme.colors.border.focus }),
                { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
            ]}
        >
            <Text numberOfLines={1} style={styles.text}>
                {working}
                {attention ? (
                    <>
                        <Text style={styles.separator}>{' · '}</Text>
                        <Text testID={testId ? `${testId}:needs-you` : undefined} style={workStatusWordStyle('attention')}>{attention}</Text>
                    </>
                ) : null}
            </Text>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
            </View>
        </HappierPressable>
        </View>
        {open ? (
            <Popover
                open
                anchorRef={anchorRef}
                placement="bottom"
                maxWidthCap={460}
                maxHeightCap={560}
                autoFocusOnOpen
                onRequestClose={close}
                portal={{ web: true, native: true, matchAnchorWidth: false }}
            >
                {({ maxHeight }) => (
                    <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
                        <SessionWorkStripPopoverContent
                            sessionId={props.sessionId}
                            serverId={props.serverId}
                            scopeId={props.scopeId}
                            line={attention ? `${working} · ${attention}` : working}
                            onOpenInSidebar={openInSidebar}
                            onClose={close}
                        />
                    </FloatingOverlay>
                )}
            </Popover>
        ) : null}
    </>);
});
