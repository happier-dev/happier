import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
    CurrentSessionPresentationBindResultV1Schema,
    CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions';

import { Text } from '@/components/ui/text/Text';
import { randomUUID } from '@/platform/randomUUID';
import { storage } from '@/sync/domains/state/storage';
import {
    getFocusedSessionId,
    subscribeSessionSurfaceVisibility,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';

import { applyCurrentSessionPresentationCommand } from './applyCurrentSessionPresentationCommand';
import {
    readSessionComposerPresentationTarget,
    subscribeSessionComposerPresentationTargets,
} from './sessionComposerPresentationTargets';

type PresentationNotice = Readonly<{
    key: string;
    message: string;
    severity: 'info' | 'warning' | 'error';
}>;

const stylesheet = StyleSheet.create((theme) => ({
    noticeHost: {
        position: 'absolute',
        top: 12,
        left: 16,
        right: 16,
        alignItems: 'center',
        zIndex: 200,
        pointerEvents: 'none',
    },
    notice: {
        maxWidth: 560,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    noticeText: {
        color: theme.colors.text.primary,
        fontSize: 14,
    },
}));

export const CurrentSessionPresentationRuntime = React.memo(function CurrentSessionPresentationRuntime() {
    const styles = stylesheet;
    const clientIdRef = React.useRef<string>(randomUUID());
    const [notice, setNotice] = React.useState<PresentationNotice | null>(null);

    React.useEffect(() => {
        const clientId = clientIdRef.current;
        const boundHostNonce = new Map<string, string>();
        const bindSignatures = new Map<string, string>();
        const inFlight = new Map<string, Promise<void>>();
        const reschedule = new Set<string>();
        const processedCommands = new Set<string>();
        let disposed = false;

        const trimProcessed = () => {
            while (processedCommands.size > 256) {
                const oldest = processedCommands.values().next().value;
                if (typeof oldest !== 'string') return;
                processedCommands.delete(oldest);
            }
        };

        const syncSession = async (sessionId: string) => {
            const session = storage.getState().sessions[sessionId];
            if (!session || session.active === false || disposed) return;
            const composer = readSessionComposerPresentationTarget(sessionId);
            const focused = getFocusedSessionId() === sessionId;
            const draftRevision = composer?.revision ?? 0;
            const signature = `${focused ? 1 : 0}:${draftRevision}`;

            if (bindSignatures.get(sessionId) !== signature) {
                const result = CurrentSessionPresentationBindResultV1Schema.parse(
                    await sessionRpcWithPreferredSessionScope({
                        sessionId,
                        method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
                        payload: { clientId, focused, draftRevision },
                        timeoutMs: 5_000,
                    }),
                );
                if (result.sessionId !== sessionId || disposed) return;
                boundHostNonce.set(sessionId, result.hostNonce);
                bindSignatures.set(sessionId, signature);
            }

            const latest = storage.getState().sessions[sessionId];
            const raw = (latest?.agentState as Record<string, unknown> | null)?.[
                CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY
            ];
            const parsed = CurrentSessionPresentationStateV1Schema.safeParse(raw);
            const hostNonce = boundHostNonce.get(sessionId);
            if (!parsed.success || !hostNonce || !parsed.data.command) return;
            const commandKey = `${hostNonce}:${parsed.data.command.id}`;
            if (processedCommands.has(commandKey)) return;
            const ack = applyCurrentSessionPresentationCommand({
                sessionId,
                state: parsed.data,
                hostNonce,
                clientId,
                focusedSessionId: getFocusedSessionId(),
                notify: (event) => setNotice({
                    key: commandKey,
                    message: event.message,
                    severity: event.severity,
                }),
                composer: readSessionComposerPresentationTarget(sessionId),
            });
            if (!ack) return;
            processedCommands.add(commandKey);
            trimProcessed();
            await sessionRpcWithPreferredSessionScope({
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
                payload: ack,
                timeoutMs: 5_000,
            });
        };

        const scheduleSession = (sessionId: string) => {
            if (inFlight.has(sessionId)) {
                reschedule.add(sessionId);
                return;
            }
            const pending = syncSession(sessionId)
                .catch(() => undefined)
                .finally(() => {
                    inFlight.delete(sessionId);
                    if (reschedule.delete(sessionId) && !disposed) scheduleSession(sessionId);
                });
            inFlight.set(sessionId, pending);
        };
        const syncAll = () => {
            for (const session of Object.values(storage.getState().sessions)) {
                if (session.active !== false) scheduleSession(session.id);
            }
        };

        syncAll();
        const unsubscribeStorage = storage.subscribe(syncAll);
        const unsubscribeVisibility = subscribeSessionSurfaceVisibility(syncAll);
        const unsubscribeComposer = subscribeSessionComposerPresentationTargets(syncAll);
        return () => {
            disposed = true;
            unsubscribeStorage();
            unsubscribeVisibility();
            unsubscribeComposer();
        };
    }, []);

    React.useEffect(() => {
        if (!notice) return;
        const timeout = setTimeout(() => setNotice((current) => current?.key === notice.key ? null : current), 4_000);
        return () => clearTimeout(timeout);
    }, [notice]);

    if (!notice) return null;
    return (
        <View style={styles.noticeHost} pointerEvents="none" testID="current-session-presentation-notice">
            <View
                style={styles.notice}
                accessibilityRole={notice.severity === 'error' ? 'alert' : 'text'}
                accessibilityLiveRegion={notice.severity === 'error' ? 'assertive' : 'polite'}
            >
                <Text style={styles.noticeText}>{notice.message}</Text>
            </View>
        </View>
    );
});
