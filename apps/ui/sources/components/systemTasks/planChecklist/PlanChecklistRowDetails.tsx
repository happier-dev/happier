import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CodeBlockViewFrame } from '@/components/ui/code/blocks/CodeBlockViewFrame';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { PlanChecklistExecutionError, PlanChecklistLogEntry } from './types';

function formatLogTimestamp(ts: number, firstTs: number): string {
    const relative = Math.max(0, ts - firstTs);
    return `+${relative}ms`;
}

function formatLogEntry(entry: PlanChecklistLogEntry, firstTs: number): string {
    const prefix = formatLogTimestamp(entry.ts, firstTs);
    const headline = `${prefix} [${entry.level}] ${entry.message}`;
    const details = typeof entry.details === 'string' ? entry.details.trim() : '';
    return details.length > 0
        ? `${headline}\n${details}`
        : headline;
}

function formatLogs(logs: readonly PlanChecklistLogEntry[]): string {
    if (logs.length === 0) {
        return '';
    }
    const firstTs = logs[0]?.ts ?? 0;
    return logs.map((entry) => formatLogEntry(entry, firstTs)).join('\n');
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
    },
    details: {
        gap: 8,
    },
    detailsTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
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
        borderColor: theme.colors.state.danger.foreground,
        backgroundColor: theme.colors.surface.base,
        padding: 12,
    },
    errorLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.state.danger.foreground,
        fontSize: 12,
        lineHeight: 16,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    errorTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 18,
    },
    errorMessage: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    logsLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    copyButtonRow: {
        alignItems: 'flex-start',
    },
    copyButton: {
        paddingHorizontal: 0,
        paddingVertical: 0,
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
    },
    copyButtonPressed: {
        opacity: 0.7,
    },
    copyButtonText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 18,
    },
    emptyText: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export type PlanChecklistRowDetailsProps = Readonly<{
    testID?: string;
    renderDetails?: () => React.ReactNode;
    detailsTitle?: React.ReactNode | null;
    childrenContent?: React.ReactNode;
    error?: PlanChecklistExecutionError;
    logs?: readonly PlanChecklistLogEntry[];
    onCopyDiagnostics?: () => boolean | void | Promise<boolean | void>;
}>;

export const PlanChecklistRowDetails = React.memo(function PlanChecklistRowDetails(props: PlanChecklistRowDetailsProps) {
    const styles = stylesheet;
    const copyFeedback = useTemporaryCopyFeedback();
    const logText = React.useMemo(() => formatLogs(props.logs ?? []), [props.logs]);
    const hasLogs = Boolean(logText.trim().length > 0);
    const hasDetails = typeof props.renderDetails === 'function';
    const hasError = Boolean(props.error?.title || props.error?.message);
    const hasChildrenContent = Boolean(props.childrenContent);
    const detailsNode = hasDetails ? props.renderDetails?.() : null;
    const normalizedDetailsNode = (typeof detailsNode === 'string' || typeof detailsNode === 'number')
        ? <Text style={styles.emptyText}>{String(detailsNode)}</Text>
        : detailsNode;

    if (!hasDetails && !hasLogs && !hasError && !hasChildrenContent) {
        return null;
    }

    const handleCopyDiagnostics = React.useCallback(() => {
        void Promise.resolve(props.onCopyDiagnostics?.()).then((copied) => {
            if (copied === true) {
                copyFeedback.markCopied('diagnostics');
            }
        });
    }, [copyFeedback, props.onCopyDiagnostics]);

    return (
        <View testID={props.testID} style={styles.root}>
            {hasDetails ? (
                <View style={styles.details}>
                    {props.detailsTitle === null
                        ? null
                        : (
                            <Text style={styles.detailsTitle}>
                                {props.detailsTitle ?? t('common.details')}
                            </Text>
                        )}
                    <View style={styles.detailsBody}>
                        {normalizedDetailsNode}
                    </View>
                </View>
            ) : null}

            {hasChildrenContent ? (
                <View style={styles.details}>
                    {props.childrenContent}
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
                    <Pressable
                        testID={props.testID ? `${props.testID}-copy-diagnostics` : undefined}
                        accessibilityRole="button"
                        onPress={handleCopyDiagnostics}
                        style={({ pressed }) => [
                            styles.copyButton,
                            pressed ? styles.copyButtonPressed : null,
                        ]}
                    >
                        {copyFeedback.isCopied('diagnostics') ? (
                            <CopiedPill visible testID={props.testID ? `${props.testID}-copy-diagnostics-feedback` : undefined} />
                        ) : (
                            <Text style={styles.copyButtonText}>
                                {t('common.copyWithLabel', { label: t('common.details') })}
                            </Text>
                        )}
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
});
