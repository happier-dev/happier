import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { Text } from '@/components/ui/text/Text';
import { resolveSubagentStructuredSend } from '@/sync/domains/input/subagents/resolveSubagentStructuredSend';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SessionSubagentRow } from './SessionSubagentRow';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 10,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '600',
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        flex: 1,
    },
    countPill: {
        minWidth: 22,
        height: 22,
        paddingHorizontal: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        alignItems: 'center',
        justifyContent: 'center',
    },
    countText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '700',
    },
    deleteButton: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    deleteButtonText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '600',
    },
}));

export const SessionSubagentGroup = React.memo((props: Readonly<{
    sessionId: string;
    label: string | null;
    subagents: readonly SessionSubagent[];
    activityPreviewById: ReadonlyMap<string, string>;
    pendingPermissionById: ReadonlyMap<string, boolean>;
    onOpenPreview: (subagent: SessionSubagent) => void;
    onOpenFull: (subagent: SessionSubagent) => void;
    onOpenAdvanced: (subagent: SessionSubagent) => void;
    onLaunchTeammate?: ((teamId: string) => void) | null;
}>) => {
    const styles = stylesheet;
    const deletableTeamId = React.useMemo(() => {
        for (const subagent of props.subagents) {
            if (subagent.kind !== 'agent_team_member' || subagent.status !== 'running') continue;
            const teamId = subagent.display.groupKey?.trim();
            if (teamId) return teamId;
        }
        return null;
    }, [props.subagents]);
    const launchableTeamId = React.useMemo(() => {
        if (typeof props.onLaunchTeammate !== 'function') return null;
        for (const subagent of props.subagents) {
            if (subagent.kind !== 'agent_team_member' || subagent.status !== 'running') continue;
            const teamId = subagent.display.groupKey?.trim();
            if (teamId) return teamId;
        }
        return null;
    }, [props.onLaunchTeammate, props.subagents]);

    const deleteTeam = React.useCallback(() => {
        if (!deletableTeamId) return;
        const structured = resolveSubagentStructuredSend({
            envelopeKind: 'subagent_command.v1',
            payload: {
                kind: 'agent_team_delete',
                teamId: deletableTeamId,
            },
        });
        fireAndForget(sync.sendMessage(props.sessionId, structured.text, structured.displayText, structured.metaOverrides), {
            tag: 'SessionSubagentGroup.deleteTeam',
        });
    }, [deletableTeamId, props.sessionId]);
    const launchTeammate = React.useCallback(() => {
        if (!launchableTeamId || typeof props.onLaunchTeammate !== 'function') return;
        props.onLaunchTeammate(launchableTeamId);
    }, [launchableTeamId, props.onLaunchTeammate]);

    return (
        <View style={styles.container}>
            {props.label ? (
                <View style={styles.header}>
                    <View style={styles.titleRow}>
                        <Text style={styles.title}>{props.label}</Text>
                        <View testID={`session-subagent-group-count:${props.label}`} style={styles.countPill}>
                            <Text style={styles.countText}>{t('session.subagents.panel.groupCount', { count: props.subagents.length })}</Text>
                        </View>
                    </View>
                    <View style={styles.headerActions}>
                        {launchableTeamId ? (
                            <Pressable
                                testID={`session-subagent-team-add:${launchableTeamId}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('session.subagents.panel.launchTeammateA11y')}
                                onPress={launchTeammate}
                                style={({ pressed }) => [styles.deleteButton, { opacity: pressed ? 0.7 : 1 }]}
                            >
                                <Text style={styles.deleteButtonText}>{t('session.subagents.panel.launchTeammateAction')}</Text>
                            </Pressable>
                        ) : null}
                        {deletableTeamId ? (
                            <Pressable
                                testID={`session-subagent-team-delete:${deletableTeamId}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('session.subagents.panel.delete')}
                                onPress={deleteTeam}
                                style={({ pressed }) => [styles.deleteButton, { opacity: pressed ? 0.7 : 1 }]}
                            >
                                <Text style={styles.deleteButtonText}>{t('session.subagents.panel.delete')}</Text>
                            </Pressable>
                        ) : null}
                    </View>
                </View>
            ) : null}
            {props.subagents.map((subagent) => (
                <SessionSubagentRow
                    key={subagent.id}
                    sessionId={props.sessionId}
                    subagent={subagent}
                    activityPreview={props.activityPreviewById.get(subagent.id) ?? null}
                    hasPendingPermission={props.pendingPermissionById.get(subagent.id) === true}
                    onOpenPreview={() => props.onOpenPreview(subagent)}
                    onOpenFull={(() => props.onOpenFull(subagent))}
                    onOpenAdvanced={subagent.capabilities.canOpenAdvancedRun ? (() => props.onOpenAdvanced(subagent)) : null}
                />
            ))}
        </View>
    );
});
