import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { createSessionAgentSignInRoute } from '@/components/sessions/presentation/sessionAgentAuthRequiredPresentation';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

export const AGENT_AUTH_REQUIRED_RECOVERY_TEST_ID = 'transcript-event-agent-auth-recovery';

/**
 * A native Agent sign-in requirement's historical notice adds the one place that fixes it: the Agent's own
 * page on the machine the Session runs on, where its sign-in and its connected accounts live. The row offers
 * it only to a viewer whose transcript knows that machine and can navigate; nothing else is inferred.
 */
export function AgentAuthRequiredRecovery(props: Readonly<{ issue: SessionRuntimeIssueV1 }>) {
    const source = useSessionTranscriptSource();
    const machineId = source.useMetadata()?.machineId ?? null;
    const route = createSessionAgentSignInRoute(props.issue, machineId, source.serverId);
    const navigate = source.navigate;
    if (!route || !navigate) return null;
    return (
        <View style={styles.footer}>
            <RoundButton
                testID={AGENT_AUTH_REQUIRED_RECOVERY_TEST_ID}
                size="small"
                display="secondary"
                title={t('session.agentAuthRequired.action')}
                onPress={() => navigate(route)}
                style={styles.action}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    footer: {
        marginTop: theme.space.s2,
        alignItems: 'flex-start',
    },
    action: {
        alignSelf: 'flex-start',
    },
}));
