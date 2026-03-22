import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionSubagentLaunchCardShell } from '@/components/sessions/agents/launch/SessionSubagentLaunchCardShell';
import { Text, TextInput } from '@/components/ui/text/Text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveSubagentStructuredSend } from '@/sync/domains/input/subagents/resolveSubagentStructuredSend';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        gap: 8,
    },
    input: {
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHigh,
        minHeight: 40,
    },
    multilineInput: {
        minHeight: 88,
        textAlignVertical: 'top',
    },
    buttonRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    button: {
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    buttonText: {
        color: theme.colors.text,
        fontSize: 12,
        fontWeight: '600',
    },
    hint: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
    teamChoices: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    teamChoiceButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    teamChoiceButtonSelected: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    teamChoiceText: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        fontWeight: '600',
    },
    teamChoiceTextSelected: {
        color: theme.colors.text,
    },
    error: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
}));

export const ClaudeAgentTeamLaunchCard = React.memo((props: Readonly<{
    sessionId: string;
    teamIds: readonly string[];
    mode?: 'all' | 'team' | 'member';
    initialTeamId?: string | null;
}>) => {
    const styles = stylesheet;
    const mode = props.mode ?? 'all';
    const [teamId, setTeamId] = React.useState('');
    const [teamDescription, setTeamDescription] = React.useState('');
    const [memberTeamId, setMemberTeamId] = React.useState((props.initialTeamId?.trim() || props.teamIds[0]) ?? '');
    const [memberLabel, setMemberLabel] = React.useState('');
    const [memberInstructions, setMemberInstructions] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [pendingAction, setPendingAction] = React.useState<'team' | 'member' | null>(null);

    React.useEffect(() => {
        if (memberTeamId.trim().length > 0) return;
        const initialTeamId = props.initialTeamId?.trim();
        if (initialTeamId) {
            setMemberTeamId(initialTeamId);
            return;
        }
        const firstTeamId = props.teamIds[0];
        if (typeof firstTeamId === 'string' && firstTeamId.trim().length > 0) {
            setMemberTeamId(firstTeamId);
        }
    }, [memberTeamId, props.initialTeamId, props.teamIds]);

    const title = mode === 'member'
        ? t('session.subagents.panel.launchTeammateAction')
        : mode === 'team'
            ? t('session.subagents.panel.launchClaudeTeamAction')
            : t('session.subagents.panel.launchClaudeTeamsTitle');

    const sendStructured = React.useCallback((action: 'team' | 'member') => {
        setError(null);
        setPendingAction(action);
        fireAndForget((async () => {
            try {
                if (action === 'team') {
                    const normalizedTeamId = teamId.trim();
                    if (!normalizedTeamId) {
                        setError(t('session.subagents.panel.errors.teamIdRequired'));
                        return;
                    }
                    const structured = resolveSubagentStructuredSend({
                        envelopeKind: 'subagent_launch.v1',
                        payload: {
                            kind: 'agent_team_create',
                            teamId: normalizedTeamId,
                            ...(teamDescription.trim() ? { description: teamDescription.trim() } : {}),
                        },
                    });
                    await getSyncSingleton().sendMessage(props.sessionId, structured.text, structured.displayText, structured.metaOverrides);
                    setTeamId('');
                    setTeamDescription('');
                    return;
                }

                const normalizedTeamId = memberTeamId.trim();
                const normalizedLabel = memberLabel.trim();
                const normalizedInstructions = memberInstructions.trim();
                if (!normalizedTeamId) {
                    setError(t('session.subagents.panel.errors.memberTeamIdRequired'));
                    return;
                }
                if (!normalizedLabel) {
                    setError(t('session.subagents.panel.errors.memberLabelRequired'));
                    return;
                }
                if (!normalizedInstructions) {
                    setError(t('session.subagents.panel.errors.memberInstructionsRequired'));
                    return;
                }

                const structured = resolveSubagentStructuredSend({
                    envelopeKind: 'subagent_launch.v1',
                    payload: {
                        kind: 'agent_team_member_create',
                        teamId: normalizedTeamId,
                        memberLabel: normalizedLabel,
                        instructions: normalizedInstructions,
                        runInBackground: true,
                    },
                });
                await getSyncSingleton().sendMessage(props.sessionId, structured.text, structured.displayText, structured.metaOverrides);
                setMemberLabel('');
                setMemberInstructions('');
            } catch (sendError) {
                setError(sendError instanceof Error ? sendError.message : t('common.requestFailed'));
            } finally {
                setPendingAction(null);
            }
        })(), { tag: 'ClaudeAgentTeamLaunchCard.sendStructured' });
    }, [memberInstructions, memberLabel, memberTeamId, props.sessionId, teamDescription, teamId]);

    return (
        <SessionSubagentLaunchCardShell
            testID="session-subagent-launch-claude-card"
            title={title}
            subtitle={t('session.subagents.panel.launchClaudeTeamsSubtitle')}
        >
            {mode !== 'member' ? (
                <View style={styles.section}>
                    <Text style={styles.hint}>{t('session.subagents.panel.teamIdLabel')}</Text>
                    <TextInput
                        value={teamId}
                        onChangeText={setTeamId}
                        placeholder={t('session.subagents.panel.teamIdPlaceholder')}
                        style={styles.input}
                    />
                    <TextInput
                        value={teamDescription}
                        onChangeText={setTeamDescription}
                        placeholder={t('session.subagents.panel.teamDescriptionPlaceholder')}
                        style={[styles.input, styles.multilineInput]}
                        multiline
                    />
                    <View style={styles.buttonRow}>
                        <Pressable
                            testID="session-subagent-launch-claude-team"
                            accessibilityRole="button"
                            accessibilityLabel={t('session.subagents.panel.launchClaudeTeamA11y')}
                            onPress={() => sendStructured('team')}
                            disabled={pendingAction !== null}
                            style={({ pressed }) => [styles.button, { opacity: pendingAction !== null ? 0.6 : pressed ? 0.7 : 1 }]}
                        >
                            <Text style={styles.buttonText}>{t('session.subagents.panel.launchClaudeTeamAction')}</Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            {mode !== 'team' ? (
                <View style={styles.section}>
                    <Text style={styles.hint}>{t('session.subagents.panel.teammateTeamIdLabel')}</Text>
                    {props.teamIds.length > 0 ? (
                        <View style={styles.teamChoices}>
                            {props.teamIds.map((existingTeamId) => {
                                const selected = existingTeamId === memberTeamId;
                                return (
                                    <Pressable
                                        key={existingTeamId}
                                        testID={`session-subagent-team-choice:${existingTeamId}`}
                                        accessibilityRole="button"
                                        onPress={() => {
                                            setMemberTeamId(existingTeamId);
                                        }}
                                        style={({ pressed }) => [
                                            styles.teamChoiceButton,
                                            selected ? styles.teamChoiceButtonSelected : null,
                                            { opacity: pressed ? 0.75 : 1 },
                                        ]}
                                    >
                                        <Text style={[styles.teamChoiceText, selected ? styles.teamChoiceTextSelected : null]}>
                                            {existingTeamId}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    ) : null}
                    <TextInput
                        value={memberTeamId}
                        onChangeText={setMemberTeamId}
                        placeholder={t('session.subagents.panel.teamIdPlaceholder')}
                        style={styles.input}
                    />
                    <TextInput
                        value={memberLabel}
                        onChangeText={setMemberLabel}
                        placeholder={t('session.subagents.panel.teammateLabelPlaceholder')}
                        style={styles.input}
                    />
                    <TextInput
                        value={memberInstructions}
                        onChangeText={setMemberInstructions}
                        placeholder={t('session.subagents.panel.teammateInstructionsPlaceholder')}
                        style={[styles.input, styles.multilineInput]}
                        multiline
                    />
                    <View style={styles.buttonRow}>
                        <Pressable
                            testID="session-subagent-launch-claude-teammate"
                            accessibilityRole="button"
                            accessibilityLabel={t('session.subagents.panel.launchTeammateA11y')}
                            onPress={() => sendStructured('member')}
                            disabled={pendingAction !== null}
                            style={({ pressed }) => [styles.button, { opacity: pendingAction !== null ? 0.6 : pressed ? 0.7 : 1 }]}
                        >
                            <Text style={styles.buttonText}>{t('session.subagents.panel.launchTeammateAction')}</Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
        </SessionSubagentLaunchCardShell>
    );
});
