import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { ITEM_ICON_BOX_SIZE, ITEM_ICON_MARGIN_RIGHT, ITEM_ROW_PADDING_HORIZONTAL, ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SELECTION_LIST_SKELETON_ROW_SHAPE } from '@/components/ui/selectionList/_constants';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { formatSessionResponsibilityName } from './formatSessionResponsibilityName';
import type { SessionResponsibilityController } from './useSessionResponsibilityController';
import type { SessionResponsibilityPickerHost } from './useSessionResponsibilityPickerHost';

const styles = StyleSheet.create((theme) => ({
    // The row sits inside the pane's foot block (user ruling 2026-09-29), which owns the frame; the
    // row keeps the block's content inset so its flag lines up with the access marks above it.
    frame: {},
    row: {
        minHeight: 40,
        paddingLeft: ITEM_ROW_PADDING_HORIZONTAL.compact,
        paddingRight: theme.space.s10,
        paddingVertical: theme.space.s8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // The flag sits in a row's icon slot, so "Responsible" starts on the same text edge as the rows above.
    mark: { width: ITEM_ICON_BOX_SIZE.compact, alignItems: 'center', marginRight: ITEM_ICON_MARGIN_RIGHT.compact - theme.space.s8 },
    pressed: { backgroundColor: theme.colors.surface.pressed },
    label: {
        ...Typography.default(),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
    grow: { flex: 1 },
    value: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, flexShrink: 1, minWidth: 0 },
    valueText: {
        ...Typography.default('semiBold'),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    valueNone: { ...Typography.default(), color: theme.colors.text.secondary },
    secondary: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s8,
    },
    link: { color: theme.colors.text.link },
}));

/**
 * The one Responsible row inside the shared Collaboration surface: the flag, the word, then the
 * person and a chevron when the viewer may change it. It lives in the pane's foot block, under who has
 * access (user ruling 2026-09-29), on every responsive host that composes it.
 *
 * One mounted controller owns candidate and mutation state; the surrounding
 * Collaboration surface creates it together with the picker host and hands both
 * to this row, because the compact host presents its step in place of that
 * surface's body rather than inside this section. The picker host owns only
 * which existing responsive selection host renders that shared model — the wide
 * anchored step or the compact pushed step. The safe current assignee comes from
 * the canonical Session projection and stays visible independently of candidate
 * failure. Focus returns to the invoking row after close.
 *
 * It never collapses: while the Session is first read it reserves its row, and a Home that does
 * not project responsibility gets one quiet line saying so — never "No one", which would be a
 * confident, wrong statement.
 */
export function SessionResponsibilitySection(props: Readonly<{
    /** The one mounted owner of candidate and mutation state for this Session. */
    controller: SessionResponsibilityController;
    /** The one responsive presentation owner, created beside that controller. */
    pickerHost: SessionResponsibilityPickerHost;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const controller = props.controller;
    const editable = controller.availability === 'editable';
    const pickerHost = props.pickerHost;
    const responsibleAccountId = controller.responsibleAccountId ?? null;
    const responsibleName = controller.responsibleAccount
        ? formatSessionResponsibilityName(controller.responsibleAccount)
        : null;
    // Responsibility changes under the reader — their own commit, or someone
    // else's arriving on the canonical projection. Announce only a committed
    // change observed while mounted, never the value that was there on arrival.
    const announcedAssignee = React.useRef<string | null | undefined>(undefined);
    React.useEffect(() => {
        if (controller.availability === 'loading' || controller.availability === 'unsupported') return;
        const previous = announcedAssignee.current;
        announcedAssignee.current = responsibleAccountId;
        if (previous === undefined || previous === responsibleAccountId) return;
        announceAccessibilityMessage(responsibleAccountId === null
            ? t('session.responsibilityA11yEmpty')
            : t('session.responsibilityA11yReadOnly', {
                name: responsibleName ?? t('session.responsibilityUnnamedPerson'),
            }));
    }, [controller.availability, responsibleAccountId, responsibleName]);

    if (controller.availability === 'loading') {
        return (
            <View style={styles.frame}>
                <SkeletonRows rows={1} {...SELECTION_LIST_SKELETON_ROW_SHAPE} rowTestID="session-responsibility-loading" />
            </View>
        );
    }

    if (controller.availability === 'unsupported') {
        return (
            <View style={styles.frame}>
                <SurfaceStateCard
                    testID="session-responsibility-unsupported"
                    size="line"
                    kind="unavailable"
                    iconName="flag"
                    title={t('session.collaboration.pane.responsibleUnsupported')}
                />
            </View>
        );
    }

    const assigned = responsibleAccountId;
    const displayName = assigned === null
        ? t('session.responsibilityNoOne')
        : responsibleName ?? t('session.responsibilityUnnamedPerson');
    const accessibilityLabel = assigned === null && editable
        ? t('session.responsibilityA11yEmpty')
        : t(editable ? 'session.responsibilityA11yEditable' : 'session.responsibilityA11yReadOnly', { name: displayName });

    return (
        <View ref={pickerHost.anchorRef} style={styles.frame} testID="session-responsibility-anchor">
            <Pressable
                ref={pickerHost.triggerRef}
                testID={props.testID ?? 'session-responsibility-row'}
                accessibilityRole={editable ? 'button' : 'text'}
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled: controller.pending, busy: controller.pending }}
                disabled={!editable || controller.pending}
                onPress={editable ? pickerHost.openPicker : undefined}
                style={({ pressed }) => [styles.row, pressed && editable ? [styles.pressed, { opacity: motionTokens.press.opacitySubtle }] : null]}
            >
                <View style={styles.mark}><Icon name="flag" size={18} color={theme.colors.text.secondary} /></View>
                <Text style={styles.label}>{t('session.responsibilityRowTitle')}</Text>
                <View style={styles.grow} />
                <View style={styles.value}>
                    {assigned === null ? null : (
                        <Avatar id={assigned} size={20} imageUrl={controller.responsibleAccount?.avatarUrl ?? null} />
                    )}
                    <Text
                        testID="session-responsibility-value"
                        style={[styles.valueText, assigned === null ? styles.valueNone : null]}
                        numberOfLines={1}
                    >
                        {displayName}
                    </Text>
                </View>
                {editable ? <Icon name="caret-down" size={13} color={theme.colors.text.tertiary} /> : null}
            </Pressable>
            {controller.pendingApproval ? (
                // The canonical Action policy is holding this assignment for
                // confirmation. The row above still shows the committed
                // assignee; this line says what is waiting and opens the one
                // approval where it is decided.
                <Pressable
                    testID="session-responsibility-approval"
                    accessibilityRole="link"
                    accessibilityLiveRegion="polite"
                    onPress={() => {
                        const pendingApproval = controller.pendingApproval;
                        if (!pendingApproval) return;
                        router.push(`/inbox/approvals/${encodeURIComponent(pendingApproval.artifactId)}?serverId=${encodeURIComponent(pendingApproval.serverId)}`);
                    }}
                >
                    <Text style={[styles.secondary, styles.link]}>{`${t('approvals.title')} · ${t('approvals.status.open')}`}</Text>
                </Pressable>
            ) : null}
            {controller.assignmentAutoFollowed ? (
                <Text testID="session-responsibility-auto-follow-explanation" accessibilityRole="text" style={styles.secondary}>
                    {t('session.follow.assignedExplanation')}
                </Text>
            ) : null}
            {pickerHost.picker}
        </View>
    );
}
