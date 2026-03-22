import * as React from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ClaudeAgentTeamLaunchCard } from '@/agents/providers/claude/sessionSubagents/ClaudeAgentTeamLaunchCard';
import type { ClaudeSubagentLauncherMode } from '@/agents/providers/claude/sessionSubagents/createClaudeSubagentLauncherDetailsTab';
import { useSessionSubagents } from '@/hooks/session/useSessionSubagents';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionMessages } from '@/sync/store/hooks';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    content: {
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
}));

export const SessionClaudeSubagentLauncherView = React.memo((props: Readonly<{
    sessionId: string;
    mode: ClaudeSubagentLauncherMode;
    initialTeamId?: string | null;
    presentation?: 'panel' | 'page';
}>) => {
    const styles = stylesheet;
    const session = useSession(props.sessionId);
    const { messages } = useSessionMessages(props.sessionId);
    const { subagents } = useSessionSubagents({
        sessionId: props.sessionId,
        session,
        messages,
    });

    const teamIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const subagent of subagents) {
            if (subagent.kind !== 'agent_team_member') continue;
            const groupKey = subagent.display.groupKey?.trim();
            if (groupKey) ids.add(groupKey);
        }
        return [...ids];
    }, [subagents]);

    return (
        <ScrollView
            testID="session-claude-subagent-launcher-scroll"
            style={styles.container}
            contentContainerStyle={styles.content}
        >
            <ClaudeAgentTeamLaunchCard
                sessionId={props.sessionId}
                teamIds={teamIds}
                mode={props.mode}
                initialTeamId={props.initialTeamId ?? null}
            />
        </ScrollView>
    );
});
