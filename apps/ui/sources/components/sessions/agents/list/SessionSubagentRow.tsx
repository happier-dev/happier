import * as React from 'react';
import { View } from 'react-native';
import { HappierWorkRowShell } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { useSessionSubagentActions } from '@/components/sessions/agents/actions/useSessionSubagentActions';
import { SessionAgentActivitySummary } from '@/components/sessions/agents/presentation/SessionAgentActivitySummary';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import type { SessionAgentActivityRow } from '@/components/sessions/agents/presentation/sessionAgentActivityRows';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { useWorkTheme } from '@/components/work/map/WorkMapView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { t } from '@/text';

/**
 * One roster row (agents lab AG1): the Agent's mark, the title, one line that says where the work
 * stands, and — while it works — the latest activity in one muted line.
 *
 * Identity and state come from `resolveSessionAgentActivityPresentation` over the canonical merged
 * entry, so this row, the Details overview and a conversation's run reference cannot disagree. The
 * row carries no buttons: its operations are one gesture away (right-click / long-press), and the
 * row itself opens the work — or, for work waiting on a person, opens in place (the list decides).
 */

const stylesheet = StyleSheet.create((theme) => ({
    activity: {
        ...Typography.default(),
        marginTop: 3,
        // Aligned under the title: past the 30px mark and its 10px gap.
        marginLeft: 40,
        color: theme.colors.text.tertiary,
        fontSize: 12,
        lineHeight: 16,
    },
}));

export const SessionSubagentRow = React.memo((props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    row: SessionAgentActivityRow;
    activityPreview?: string | null;
    /** Where this work came from ("from Relay retry plan"), when the host resolved it. */
    originLabel?: string | null;
    /** The Session's own Agent, for the mark of work that does not name its own backend. */
    sessionAgentId?: string | null;
    /** What pressing the row does: open the work, or (needs-you rows) open it in place. */
    onPress: () => void;
    /** Set on a row that opens in place; announced as a disclosure. */
    expanded?: boolean;
    selected?: boolean;
    onOpenFull: (() => void) | null;
    onOpenAdvanced: (() => void) | null;
}>) => {
    const styles = stylesheet;
    const router = useRouter();
    const workTheme = useWorkTheme();
    const { entry, subagent } = props.row;
    const originLabel = props.originLabel ?? null;
    const sessionAgentId = props.sessionAgentId ?? null;
    const presentation = React.useMemo(
        () => resolveSessionAgentActivityPresentation({ entry, subagent, originLabel, sessionAgentId }),
        [entry, originLabel, sessionAgentId, subagent],
    );
    const actions = useSessionSubagentActions({
        sessionId: props.sessionId,
        serverId: props.serverId,
        subagent,
        onOpenFull: props.onOpenFull,
        onOpenAdvanced: props.onOpenAdvanced,
    });
    const anchorRef = React.useRef<View>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const hasActions = actions.items.length > 0;
    const openMenu = React.useCallback(() => {
        if (hasActions) setMenuOpen(true);
    }, [hasActions]);
    const { onPress } = props;

    const body = (
        <>
            <SessionAgentActivitySummary
                testID={`session-subagent-summary:${subagent.id}`}
                presentation={presentation}
                showTime
            />
            {presentation.phase === 'live' && props.activityPreview ? (
                <Text
                    testID={`session-subagent-activity:${subagent.id}`}
                    numberOfLines={1}
                    style={styles.activity}
                >
                    {props.activityPreview}
                </Text>
            ) : null}
        </>
    );
    // A sibling of the row, never its child: a portal still bubbles React events to its ancestors,
    // and a press on a menu item must not also open the row.
    const menu = hasActions ? (
        <ContextMenu
            testID={`session-subagent-actions:${subagent.id}`}
            anchorRef={anchorRef}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={actions.items}
            onSelect={(itemId) => {
                setMenuOpen(false);
                actions.select(itemId);
            }}
        />
    ) : null;

    return (<>
        <HappierWorkRowShell
            // The shared pressable publishes its actual RN View through the portable focus boundary.
            controlRef={(instance) => { anchorRef.current = instance as View | null; }}
            testID={`session-subagent-row:${subagent.id}`}
            accessibilityLabel={presentation.accessibilityLabel}
            selected={props.selected ?? props.expanded}
            expanded={props.expanded}
            onPress={onPress}
            onLongPress={hasActions ? openMenu : undefined}
            onContextMenu={hasActions ? (event) => {
                if (event && typeof event === 'object' && 'preventDefault' in event && typeof event.preventDefault === 'function') event.preventDefault();
                openMenu();
            } : undefined}
            theme={workTheme}
        >
            {body}
        </HappierWorkRowShell>
        {actions.approval.approvalPending && actions.approval.approvalId && props.serverId ? (
            <ActionApprovalPendingNotice testID={`session-subagent-stop-approval:${subagent.id}`}
                message={t('approvals.status.open')}
                onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(actions.approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId!)}`)} />
        ) : null}
        {menu}
    </>);
});
