import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeBlockViewFrame } from '@/components/ui/code/blocks/CodeBlockViewFrame';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { PlanChecklistExecutionError, PlanChecklistLogEntry } from './types';

function formatLogEntry(entry: PlanChecklistLogEntry): string {
    const prefix = `${entry.ts}ms`;
    return `${prefix} [${entry.level}] ${entry.message}`;
}

function formatLogs(logs: readonly PlanChecklistLogEntry[]): string {
    return logs.map((entry) => formatLogEntry(entry)).join('\n');
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 0,
        paddingBottom: 16,
    },
    details: {
        gap: 8,
    },
    detailsTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 18,
    },
    detailsBody: {
        gap: 8,
    },
    errorCard: {
        gap: 6,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.warningCritical,
        backgroundColor: theme.colors.surface,
        padding: 12,
    },
    errorLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.warningCritical,
        fontSize: 12,
        lineHeight: 16,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    errorTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
    },
    errorMessage: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    logsLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    copyButtonRow: {
        alignItems: 'flex-start',
    },
    emptyText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export type PlanChecklistRowDetailsProps = Readonly<{
    testID?: string;
    renderDetails?: () => React.ReactNode;
    error?: PlanChecklistExecutionError;
    logs?: readonly PlanChecklistLogEntry[];
    onCopyDiagnostics?: () => void | Promise<void>;
}>;

export const PlanChecklistRowDetails = React.memo(function PlanChecklistRowDetails(props: PlanChecklistRowDetailsProps) {
    const styles = stylesheet;
    const logText = React.useMemo(() => formatLogs(props.logs ?? []), [props.logs]);
    const hasLogs = Boolean(logText.trim().length > 0);
    const hasDetails = typeof props.renderDetails === 'function';
    const hasError = Boolean(props.error?.title || props.error?.message);
    const detailsNode = hasDetails ? props.renderDetails?.() : null;
    const normalizedDetailsNode = (typeof detailsNode === 'string' || typeof detailsNode === 'number')
        ? <Text style={styles.emptyText}>{String(detailsNode)}</Text>
        : detailsNode;

    if (!hasDetails && !hasLogs && !hasError && !props.onCopyDiagnostics) {
        return null;
    }

    return (
        <View testID={props.testID} style={styles.root}>
            {hasDetails ? (
                <View style={styles.details}>
                    <Text style={styles.detailsTitle}>{t('common.details')}</Text>
                    <View style={styles.detailsBody}>
                        {normalizedDetailsNode}
                    </View>
                </View>
            ) : null}

            {hasError ? (
                <View style={styles.errorCard}>
                    <Text style={styles.errorLabel}>{t('common.error')}</Text>
                    {props.error?.title ? <Text style={styles.errorTitle}>{props.error.title}</Text> : null}
                    {props.error?.message ? <Text style={styles.errorMessage}>{props.error.message}</Text> : null}
                </View>
            ) : null}

            {hasLogs ? (
                <View style={styles.details}>
                    <Text style={styles.logsLabel}>{t('common.logs')}</Text>
                    <CodeBlockViewFrame
                        code={logText}
                        language={null}
                        showHeaderRow={false}
                        selectable={true}
                        wrap={false}
                        showCopyButton={false}
                        scrollTestID={props.testID ? `${props.testID}-logs-scroll` : undefined}
                    >
                        <Text selectable={true} style={styles.codeText}>
                            {logText}
                        </Text>
                    </CodeBlockViewFrame>
                </View>
            ) : null}

            {props.onCopyDiagnostics ? (
                <View style={styles.copyButtonRow}>
                    <RoundButton
                        testID={props.testID ? `${props.testID}-copy-diagnostics` : undefined}
                        size="small"
                        display="inverted"
                        title={t('common.copyWithLabel', { label: t('common.details') })}
                        onPress={() => void props.onCopyDiagnostics?.()}
                    />
                </View>
            ) : null}
        </View>
    );
});
