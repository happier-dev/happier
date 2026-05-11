import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        gap: 12,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerCopy: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    title: {
        color: theme.colors.text.primary,
        fontSize: 15,
        fontWeight: '700',
    },
    subtitle: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    statusPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    statusText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '700',
    },
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    factPill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    factText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        fontWeight: '600',
    },
}));

function resolveIntentLabel(intent: unknown): string | null {
    const normalized = typeof intent === 'string' ? intent.trim() : '';
    if (!normalized) return null;
    if (normalized === 'review' || normalized === 'plan' || normalized === 'delegate') {
        return t(`session.subagents.intent.${normalized}` as const);
    }
    return normalized;
}

function buildFacts(run: ExecutionRunPublicState): readonly string[] {
    const backendLabel = resolveExecutionRunBackendLabel(run.backendTarget);
    const modeParts = [
        typeof (run as any).runClass === 'string' ? String((run as any).runClass) : null,
        typeof (run as any).ioMode === 'string' ? String((run as any).ioMode) : null,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return [
        backendLabel
            ? t('executionRuns.details.labels.backend', { value: backendLabel })
            : null,
        typeof (run as any).permissionMode === 'string'
            ? t('executionRuns.details.labels.permissions', { value: String((run as any).permissionMode) })
            : null,
        modeParts.length > 0
            ? t('executionRuns.details.labels.mode', { value: modeParts.join(' · ') })
            : null,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function resolveTitle(run: ExecutionRunPublicState): string {
    const intentLabel = resolveIntentLabel((run as any).intent);
    if (intentLabel) {
        return t('executionRuns.details.titles.executionRunWithIntent', { intent: intentLabel });
    }
    return t('executionRuns.details.titles.executionRun');
}

export const SessionExecutionRunInfoCard = React.memo((props: Readonly<{
    run: ExecutionRunPublicState;
    daemonProcessLine?: string | null;
}>) => {
    const styles = stylesheet;
    const facts = React.useMemo(() => buildFacts(props.run), [props.run]);

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <View style={styles.headerCopy}>
                    <Text style={styles.title}>{resolveTitle(props.run)}</Text>
                    <Text style={styles.subtitle}>
                        {t('executionRuns.details.labels.runId', { value: props.run.runId })}
                    </Text>
                    {props.daemonProcessLine ? <Text style={styles.subtitle}>{props.daemonProcessLine}</Text> : null}
                </View>
                <View style={styles.statusPill}>
                    <Text style={styles.statusText}>
                        {t('executionRuns.details.labels.statusValue', { value: String((props.run as any).status ?? 'unknown') })}
                    </Text>
                </View>
            </View>
            {facts.length > 0 ? (
                <View style={styles.facts}>
                    {facts.map((fact) => (
                        <View key={fact} style={styles.factPill}>
                            <Text style={styles.factText}>{fact}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
            <View style={styles.headerCopy}>
                {typeof props.run.startedAtMs === 'number' ? (
                    <Text style={styles.subtitle}>
                        {t('executionRuns.details.timestamps.started')} {new Date(props.run.startedAtMs).toLocaleString()}
                    </Text>
                ) : null}
                {typeof (props.run as any).finishedAtMs === 'number' ? (
                    <Text style={styles.subtitle}>
                        {t('executionRuns.details.timestamps.finished')} {new Date((props.run as any).finishedAtMs).toLocaleString()}
                    </Text>
                ) : null}
            </View>
        </View>
    );
});
