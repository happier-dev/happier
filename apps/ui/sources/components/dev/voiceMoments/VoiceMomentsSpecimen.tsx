import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildVoicePresenceSurfaceFixture } from '@/components/dev/voicePresence/voicePresenceFixtures';
import { VoiceGlance } from '@/components/voice/presence/VoiceGlance';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { Text } from '@/components/ui/text/Text';

/**
 * Dev-only: real Voice sections at N1, END, POSTEND, C1 and CX. Pending data is synthetic,
 * client-local and removed on unmount; it never becomes a server Session. View access is a hard
 * approval denial, so the real request cards cannot issue a permission response. This intentionally
 * previews the read-only N1 boundary rather than fabricating enabled Allow / Deny actions.
 */
export function VoiceMomentsSpecimen(props: Readonly<{ frame: string }>): React.ReactElement {
    const accountScope = useActiveServerAccountScope();
    const specimenId = `dev-voice-moments-${React.useId()}`;
    const serverId = accountScope?.serverId ?? getActiveServerSnapshot().serverId;
    const address = React.useMemo(() => ({ serverId, sessionId: specimenId }), [serverId, specimenId]);
    const pending = props.frame === 'N1' || props.frame === 'POSTEND';
    const [seeded, setSeeded] = React.useState(false);
    React.useEffect(() => {
        if (!pending) { setSeeded(false); return; }
        const session = createSessionFixture({
            id: address.sessionId, serverId: address.serverId, active: true, accessLevel: 'view',
            metadata: { path: '/voice-specimen', host: 'Dev specimen', homeDir: '/', machineId: 'dev-voice-moments' },
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1,
            agentState: { requests: { 'dev-voice-permission': { tool: 'Bash', arguments: { command: 'git status' }, createdAt: 1 } } },
        });
        const messages = createSessionMessagesFixture({ isLoaded: true });
        const state = storage.getState();
        // Do not replace an existing local entry, even in a dev specimen.
        if (state.sessions[address.sessionId] || state.sessionMessages[address.sessionId]) return;
        storage.setState({ sessions: { ...state.sessions, [session.id]: session }, sessionMessages: { ...state.sessionMessages, [session.id]: messages } });
        setSeeded(true);
        return () => {
            storage.setState((current) => {
                const sessions = { ...current.sessions };
                const sessionMessages = { ...current.sessionMessages };
                if (sessions[session.id] === session) delete sessions[session.id];
                if (sessionMessages[session.id] === messages) delete sessionMessages[session.id];
                return { sessions, sessionMessages };
            });
        };
    }, [address, pending]);
    const model = React.useMemo((): VoiceSurfaceViewModel => {
        if (props.frame === 'N1') {
            const base = buildVoicePresenceSurfaceFixture('needs_you');
            return { ...base, delegatedWork: null, attemptControl: { ...base.attemptControl, openConversationSessionId: address.sessionId, openConversationSessionAddress: address } };
        }
        const base = buildVoicePresenceSurfaceFixture('ended');
        if (props.frame === 'END') return base;
        const ended = base.attemptControl.ended!;
        if (props.frame === 'POSTEND') {
            return { ...base, attemptControl: { ...base.attemptControl, ended: { ...ended, accountScope, targetSessionAddress: address, conversationSessionAddress: null } } };
        }
        return {
            ...base,
            attemptControl: {
                ...base.attemptControl,
                ended: {
                    ...ended,
                    reason: {
                        kind: 'continued_elsewhere',
                        continuation: {
                            v: 1,
                            deviceId: 'dev-other-device',
                            deviceDisplayName: props.frame === 'CX' ? null : 'iPhone',
                            conversation: { serverId: 'dev', sessionId: 'dev-conversation' },
                        },
                    },
                },
            },
        };
    }, [accountScope, address, props.frame]);
    return (
        <ScrollView style={styles.page} contentContainerStyle={styles.content}>
            <View style={styles.column}>
                {props.frame !== 'H1' && (!pending || seeded) ? <VoiceGlance model={model} presentation="companion" testID="dev-voice-moments" /> : null}
                {props.frame === 'POSTEND' && !accountScope ? <Text style={styles.notice}>Sign in to preview the Account-scoped ended request.</Text> : null}
                {props.frame === 'H1' ? <Text style={styles.notice}>Hold requires a connected Voice controller; this specimen does not open microphone or network transports.</Text> : null}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.background.canvas },
    content: { padding: 24 },
    column: { width: '100%', maxWidth: 340 },
    notice: { color: theme.colors.text.primary },
}));
