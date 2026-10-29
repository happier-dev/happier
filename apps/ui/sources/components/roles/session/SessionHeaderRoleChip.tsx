import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_BADGE_METRICS, HappierPressable, HappierRoleMark } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderTitleAccessoryCompactContext } from '@/components/sessions/shell/view/sessionHeaderTitleCompact';
import { t } from '@/text';

import { SessionRolePopover, useSessionRoleSelection } from './sessionRole';

/** Closed chrome shares the selected-role owner without starting a full catalog request. */
export const SessionHeaderRoleChip = React.memo(function SessionHeaderRoleChip(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    roleId: string;
}>) {
    const { theme } = useUnistyles();
    const { selection } = useSessionRoleSelection(props.sessionId, props.roleId, props.serverId, false);
    const roleName = selection?.name ?? t('roles.session.refusal.roleUnavailableTitle');
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const toggle = React.useCallback(() => setOpen((current) => !current), []);
    // Where the title and the whole chip no longer fit, the chip is its role's mark (never "O…");
    // the role name stays in its accessible label and in the popover it opens.
    const compact = React.useContext(SessionHeaderTitleAccessoryCompactContext) && selection != null;
    const close = React.useCallback(() => setOpen(false), []);

    return (<>
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            <HappierPressable
                testID="session-header-role-chip"
                accessibilityRole="button"
                accessibilityLabel={t('sessionWork.role.a11y', { role: roleName })}
                hasPopup="dialog"
                expanded={open}
                onPress={toggle}
                style={({ focused, pressed }) => [
                    styles.chip,
                    focusRingStyle({ focused, color: theme.colors.border.focus }),
                    { opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
                ]}
            >
                <StatusPill
                    variant="neutral"
                    label={compact ? '' : roleName}
                    accessibilityLabel={roleName}
                    labelVariant="phrase"
                    labelNumberOfLines={1}
                    style={styles.anchor}
                    leading={selection ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        <HappierRoleMark roleId={props.roleId} runsAs={selection.runsAs.kind} renderGlyph={(glyph) => (
                            <Icon name={glyph} size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.text.secondary} />
                        )} />
                    </View> : undefined}
                />
            </HappierPressable>
        </View>
        {open ? <SessionRolePopover
            sessionId={props.sessionId}
            serverId={props.serverId}
            anchorRef={anchorRef}
            onRequestClose={close}
        /> : null}
    </>);
});

const styles = StyleSheet.create({
    anchor: { flexShrink: 1, minWidth: 0 },
    chip: { flexShrink: 1, borderRadius: HAPPIER_BADGE_METRICS.radius },
});
