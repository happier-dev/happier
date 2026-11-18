import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { SessionStartFailureBanner } from '@/components/sessions/startFailure/SessionStartFailureBanner';
import { resolveSessionStartFailureNotice } from '@/components/sessions/startFailure/sessionStartFailureNotice';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only: the start-failure notice an inactive Session shows above its composer, mounted through the
 * real notice owner and banner for each closed-cause shape a QA Machine cannot produce on demand:
 * a retryable startup refusal, a non-retryable one, a disabled Agent plugin and a model that must be
 * chosen. `?cause=retry|blocked|plugin|model|all` (default all). No RPC is issued.
 */
export type SessionStartFailureSpecimenCause = 'retry' | 'blocked' | 'plugin' | 'model';

const ISSUES = {
    retry: { code: 'agent_startup_model_reconciliation_failed', source: 'agent_session_error',
        failureCause: { phase: 'client_start', failureReason: 'unknown', requestId: 'req-7f3a' } },
    blocked: { code: 'codex_refresh_free_auth_unsupported', source: 'auth_error', agentId: 'codex' },
    plugin: { code: 'plugin_disabled', source: 'agent_session_error' },
    model: { code: 'agent_startup_model_reconciliation_failed', source: 'agent_session_error',
        failureCause: { phase: 'client_start', failureReason: 'model_selection_required', retryable: false } },
} as const;

function noticeFor(cause: SessionStartFailureSpecimenCause) {
    const issue = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed',
        occurredAt: Date.UTC(2026, 10, 17, 9, 40), ...ISSUES[cause] });
    return resolveSessionStartFailureNotice({ issue, sessionActive: false });
}

const noop = () => {};

function Scene(props: Readonly<{ cause: SessionStartFailureSpecimenCause }>) {
    const notice = React.useMemo(() => noticeFor(props.cause), [props.cause]);
    if (!notice) return <Text>{`No notice for ${props.cause}`}</Text>;
    return (
        <View testID={`session-start-failure-specimen-${props.cause}`} style={styles.scene}>
            <Text style={styles.label}>{props.cause}</Text>
            <SessionStartFailureBanner notice={notice} retry={{ run: noop, busy: false }}
                {...(props.cause === 'plugin' ? { managePlugin: noop } : {})}
                {...(props.cause === 'model' ? { chooseModel: noop } : {})}
                {...(props.cause === 'blocked' ? { signIn: noop } : {})} />
        </View>
    );
}

const ALL: readonly SessionStartFailureSpecimenCause[] = ['retry', 'blocked', 'plugin', 'model'];

export function SessionStartFailureSpecimen(props: Readonly<{ cause: SessionStartFailureSpecimenCause | 'all' }>) {
    const causes = props.cause === 'all' ? ALL : [props.cause];
    return (
        <ScrollView testID="session-start-failure-specimen" style={styles.root} contentContainerStyle={styles.content}>
            {causes.map(cause => <Scene key={cause} cause={cause} />)}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    content: { paddingVertical: theme.space.s24, gap: theme.space.s24 },
    scene: { gap: theme.space.s8 },
    label: { ...Typography.variant('meta'), color: theme.colors.text.secondary, paddingHorizontal: theme.space.s16 },
}));
