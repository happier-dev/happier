import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierFactLine, HappierPressable, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

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
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
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
        // Transparent until hovered (lab `session-C`): the strip reads as part of the header row.
        backgroundColor: 'transparent',
    },
    stripHovered: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    text: {
        ...Typography.default(),
        ...Typography.tabular(),
        flexShrink: 1,
        color: theme.colors.text.primary,
        fontSize: 12.5,
        lineHeight: 16,
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
    const workTheme = useWorkTheme();
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
    // The Work tab says the same thing at length; while it is open beside the session the glance
    // steps aside (lab `session-C`: hidden while the tab is open).
    const workTabOpen = pane.scopeState?.right.isOpen === true && pane.scopeState.right.activeTabId === 'agents';
    if (outstanding <= 0 || workTabOpen) return null;

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
            style={({ focused, pressed, hovered }) => [
                styles.strip,
                hovered || open ? styles.stripHovered : null,
                focusRingStyle({ focused, color: theme.colors.border.focus }),
                { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
            ]}
        >
            <HappierFactLine numberOfLines={1} style={styles.text} theme={workTheme} host={WORK_HOST}
                facts={[working, attention ? <Text testID={testId ? `${testId}:needs-you` : undefined} style={workStatusWordStyle('attention')}>{attention}</Text> : null]} />
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
                            line={joinHappierFacts(working, attention)}
                            onOpenInSidebar={openInSidebar}
                            onClose={close}
                        />
                    </FloatingOverlay>
                )}
            </Popover>
        ) : null}
    </>);
});
