import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isExecutionRunActive, resolveExecutionRunLinkDeliveryStateV1, type ExecutionRunPublicState } from '@happier-dev/protocol';
import { ExecutionRunStatusPill } from './ExecutionRunStatusPill';
import { Text } from '@/components/ui/text/Text';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { formatExecutionRunDeliveryState } from './executionRunLinkStatusLabels';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';


export type ExecutionRunRowRun =
    Pick<ExecutionRunPublicState, 'runId' | 'intent' | 'backendTarget' | 'status' | 'display'>
    & Partial<Pick<ExecutionRunPublicState,
        'startedAtMs' | 'finishedAtMs' | 'runClass' | 'turnInFlight' | 'linkedSessionId' | 'linkState'
        | 'visibility' | 'role' | 'modelId' | 'permissionMode'>>;

export const ExecutionRunRow = React.memo((props: Readonly<{
    run: ExecutionRunRowRun;
    onPress?: () => void;
    subtitle?: string;
    rightAccessory?: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const { run, onPress } = props;
    const navigateToSession = useNavigateToSession();
    const linkedSessionId = typeof run.linkedSessionId === 'string' && run.linkedSessionId.trim().length > 0
        ? run.linkedSessionId.trim()
        : null;
    const linkedSessionServerId = usePreferredServerIdForSession(linkedSessionId ?? '');
    const deliveryLabel = linkedSessionId
        ? formatExecutionRunDeliveryState(resolveExecutionRunLinkDeliveryStateV1(run.linkState))
        : null;
    const controlsLabel = run.visibility === 'session'
        ? [
            t('visibleAgents.visibility.session'),
            run.role?.name ? t('visibleAgents.role', { value: run.role.name }) : null,
            run.modelId ? t('visibleAgents.model', { value: run.modelId }) : t('visibleAgents.modelUnset'),
            run.permissionMode ? t('executionRuns.details.labels.permissions', { value: run.permissionMode }) : null,
        ].filter((value): value is string => Boolean(value)).join(' · ')
        : null;
    const subtitle = typeof props.subtitle === 'string' ? props.subtitle : run.runId;
    const backendLabel = resolveExecutionRunBackendLabel(run.backendTarget);
    const displayTitle = run.display?.title?.trim();
    const participantLabel = run.display?.participantLabel?.trim();
    const title = displayTitle || participantLabel || (backendLabel ? `${run.intent} · ${backendLabel}` : run.intent);

    return (
        <View style={{
                borderRadius: 12,
                backgroundColor: theme.colors.surface.inset,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                overflow: 'hidden',
            }}>
            <Pressable
                onPress={onPress}
                disabled={!onPress}
                style={({ pressed }) => ({ padding: 12, gap: 8, opacity: pressed ? 0.8 : 1 })}
            >
                <View style={styles.row}>
                    <Text style={[styles.title, { color: theme.colors.text.primary }]} numberOfLines={1}>
                        {title}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <ExecutionRunStatusPill status={run.status} isActive={isExecutionRunActive(run)} />
                        {props.rightAccessory ?? null}
                    </View>
                </View>
                <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]} numberOfLines={1}>
                    {subtitle}
                </Text>
                {controlsLabel ? (
                    <Text testID={`execution-run-controls-${run.runId}`} style={[styles.delivery, { color: theme.colors.text.secondary }]} numberOfLines={2}>
                        {controlsLabel}
                    </Text>
                ) : null}
                {deliveryLabel ? (
                    <Text
                        testID={`execution-run-delivery-status-${run.runId}`}
                        style={[styles.delivery, { color: theme.colors.text.secondary }]}
                        numberOfLines={1}
                    >
                        {deliveryLabel}
                    </Text>
                ) : null}
            </Pressable>
            {linkedSessionId ? (
                <Pressable
                    testID={`execution-run-linked-session-${run.runId}`}
                    accessibilityRole="button"
                    onPress={() => { void navigateToSession(linkedSessionId, { serverId: linkedSessionServerId }); }}
                    style={({ pressed }) => ({
                        paddingHorizontal: 12,
                        paddingVertical: 9,
                        borderTopWidth: 1,
                        borderTopColor: theme.colors.border.default,
                        opacity: pressed ? 0.7 : 1,
                    })}
                >
                    <Text style={[styles.delivery, { color: theme.colors.accent.blue }]} numberOfLines={1}>
                        {t('runs.openSession')} · {linkedSessionId}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    title: {
        fontWeight: '600',
        fontSize: 13,
    },
    subtitle: {
        fontFamily: 'Menlo',
        fontSize: 12,
    },
    delivery: {
        fontSize: 11,
        fontWeight: '600',
    },
}));
