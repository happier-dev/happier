import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { shallow } from 'zustand/shallow';

import type { SessionAgentActivityRow } from '@/components/sessions/agents/presentation/sessionAgentActivityRows';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveSubagentStructuredSend } from '@/sync/domains/input/subagents/resolveSubagentStructuredSend';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SessionAgentNeedsYouItem } from './SessionAgentNeedsYouItem';
import { SessionSubagentRow } from './SessionSubagentRow';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 0,
    },
    // A quiet line above its members, not a card and not a second section title.
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 24,
        marginTop: 6,
        marginBottom: 2,
        paddingLeft: 12,
    },
    label: {
        ...Typography.default(),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.tertiary,
        fontSize: 11.5,
        lineHeight: 16,
    },
    members: {
        paddingLeft: 12,
    },
}));

type TeamCommand = 'add-teammate' | 'delete-team';

type SessionSubagentGroupProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    session?: Session | null;
    sessionAgentId?: string | null;
    label: string | null;
    rows: readonly SessionAgentActivityRow[];
    activityPreviewById: ReadonlyMap<string, string>;
    /** Where each row came from ("from Relay retry plan"), keyed by subagent id. */
    originLabelById?: ReadonlyMap<string, string>;
    onOpenPreview: (subagent: SessionSubagent) => void;
    onOpenFull: (subagent: SessionSubagent) => void;
    onOpenAdvanced: (subagent: SessionSubagent) => void;
    onLaunchTeammate?: ((teamId: string) => void) | null;
    /** Rows here wait on a person and open in place instead of opening the work (Needs you). */
    expandable?: boolean;
    expandedId?: string | null;
    onToggleExpanded?: (subagentId: string) => void;
}>;

/** Bind actions at the row, so updating a sibling never replaces this row's callbacks. */
const BoundSubagentRow = React.memo(function BoundSubagentRow(props: Pick<SessionSubagentGroupProps,
    'sessionId' | 'serverId' | 'session' | 'sessionAgentId' | 'onOpenPreview' | 'onOpenFull' | 'onOpenAdvanced' | 'onToggleExpanded'> & Readonly<{
        row: SessionAgentActivityRow; activityPreview: string | null; originLabel: string | null; expandable: boolean; expanded: boolean;
    }>) {
    const { subagent } = props.row;
    const { onOpenPreview, onOpenFull, onOpenAdvanced } = props;
    const openPreview = React.useCallback(() => onOpenPreview(subagent), [onOpenPreview, subagent]);
    const openFull = React.useCallback(() => onOpenFull(subagent), [onOpenFull, subagent]);
    const openAdvanced = React.useCallback(() => onOpenAdvanced(subagent), [onOpenAdvanced, subagent]);
    const shared = { sessionId: props.sessionId, serverId: props.serverId, row: props.row, activityPreview: props.activityPreview,
        originLabel: props.originLabel, sessionAgentId: props.sessionAgentId,
        onOpenFull: openFull, onOpenAdvanced: subagent.capabilities.canOpenAdvancedRun ? openAdvanced : null };
    return props.expandable && props.onToggleExpanded
        ? <SessionAgentNeedsYouItem {...shared} session={props.session ?? null} expanded={props.expanded} onToggle={props.onToggleExpanded} onOpen={onOpenPreview} />
        : <SessionSubagentRow {...shared} onPress={openPreview} />;
}, (a, b) => {
    const { row: rowA, ...restA } = a;
    const { row: rowB, ...restB } = b;
    return rowA.entry === rowB.entry && rowA.subagent === rowB.subagent && shallow(restA, restB);
});

export const SessionSubagentGroup = React.memo((props: SessionSubagentGroupProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const liveTeamId = React.useMemo(() => {
        for (const { subagent } of props.rows) {
            if (subagent.kind !== 'agent_team_member' || subagent.status !== 'running') continue;
            const teamId = subagent.display.groupKey?.trim();
            if (teamId) return teamId;
        }
        return null;
    }, [props.rows]);
    const canLaunchTeammate = liveTeamId !== null && typeof props.onLaunchTeammate === 'function';

    const teamItems = React.useMemo((): readonly DropdownMenuItem[] => {
        if (!liveTeamId) return [];
        const items: DropdownMenuItem[] = [];
        if (canLaunchTeammate) {
            items.push({ id: 'add-teammate', testID: `session-subagent-team-add:${liveTeamId}`, title: t('session.subagents.panel.launchTeammateAction') });
        }
        items.push({ id: 'delete-team', testID: `session-subagent-team-delete:${liveTeamId}`, title: t('session.subagents.messages.command.deleteTeamTitle'), destructive: true });
        return items;
    }, [canLaunchTeammate, liveTeamId]);

    const { onLaunchTeammate, sessionId } = props;
    const runTeamCommand = React.useCallback((command: TeamCommand) => {
        if (!liveTeamId) return;
        if (command === 'add-teammate') {
            onLaunchTeammate?.(liveTeamId);
            return;
        }
        const structured = resolveSubagentStructuredSend({
            envelopeKind: 'subagent_command.v1',
            payload: { kind: 'agent_team_delete', teamId: liveTeamId },
        });
        fireAndForget(
            sync.submitMessage(sessionId, structured.text, structured.displayText, structured.metaOverrides, {
                callerSurface: 'subagent_command',
                forceImmediate: true,
            }),
            { tag: 'SessionSubagentGroup.deleteTeam' },
        );
    }, [liveTeamId, onLaunchTeammate, sessionId]);

    const renderRow = (row: SessionAgentActivityRow) => {
        const { subagent } = row;
        return <BoundSubagentRow key={subagent.id}
            sessionId={props.sessionId} serverId={props.serverId} session={props.session}
            row={row} activityPreview={props.activityPreviewById.get(subagent.id) ?? null}
            originLabel={props.originLabelById?.get(subagent.id) ?? null} sessionAgentId={props.sessionAgentId ?? null}
            onOpenPreview={props.onOpenPreview} onOpenFull={props.onOpenFull} onOpenAdvanced={props.onOpenAdvanced}
            expandable={props.expandable === true} expanded={props.expandedId === subagent.id} onToggleExpanded={props.onToggleExpanded}
        />;
    };

    if (!props.label) {
        return <View style={styles.container}>{props.rows.map(renderRow)}</View>;
    }

    return (
        <View style={styles.container}>
            <View testID={`session-subagent-group:${props.label}`} style={styles.header}>
                <Icon name="users" size={12} color={theme.colors.text.tertiary} />
                <Text numberOfLines={1} style={styles.label}>
                    {t('sessionAgentActivity.roster.teamLabel', { team: props.label, count: props.rows.length })}
                </Text>
                {teamItems.length > 0 ? (
                    <DropdownMenu
                        testID={`session-subagent-team-actions:${props.label}`}
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={teamItems}
                        matchTriggerWidth={false}
                        onSelect={(itemId) => {
                            setMenuOpen(false);
                            runTeamCommand(itemId as TeamCommand);
                        }}
                        trigger={({ toggle }) => (
                            <IconButton
                                testID={`session-subagent-team-menu:${props.label}`}
                                iconName="dots-three"
                                iconSize={14}
                                size={24}
                                variant="plain"
                                accessibilityLabel={t('sessionAgentActivity.roster.teamActionsA11y')}
                                tooltip={t('sessionAgentActivity.roster.teamActionsA11y')}
                                onPress={toggle}
                            />
                        )}
                    />
                ) : null}
            </View>
            <View style={styles.members}>{props.rows.map(renderRow)}</View>
        </View>
    );
});
