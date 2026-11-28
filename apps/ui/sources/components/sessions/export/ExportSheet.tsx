import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StepProgressList, type StepProgressItem } from '@/components/ui/feedback/StepProgressList';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { TranscriptExportFormat } from '@/sync/api/session/serializeTranscript';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

import {
    runTranscriptExport,
    type TranscriptExportProgress,
    type TranscriptExportResult,
    type TranscriptExportScope,
    type TranscriptExportStep,
} from './transcriptExportJob';

type ScopeKind = TranscriptExportScope['kind'];

export type ExportSheetProps = CustomModalInjectedProps & Readonly<{
    /** Offers "This session" (and, with `selectedMessages`, the selection). */
    sessionId?: string | null;
    /** The messages picked in the transcript; offers "Selected". */
    selectedMessages?: readonly Message[] | null;
    initialScope: ScopeKind;
    /** Sessions on the cloud, when the opener already knows it; turns "everything" progress into a bar. */
    totalSessions?: number | null;
}>;

type Phase =
    | Readonly<{ kind: 'choose' }>
    | Readonly<{ kind: 'running'; progress: TranscriptExportProgress; total: number | null; step?: TranscriptExportStep }>
    | Readonly<{ kind: 'done'; result: TranscriptExportResult; exported: number }>
    | Readonly<{ kind: 'error'; message: string }>;

const CHOOSE: Phase = { kind: 'choose' };
const NO_PROGRESS: TranscriptExportProgress = { done: 0, failed: 0 };

function scopeTitle(kind: ScopeKind): string {
    if (kind === 'selection') return t('transcriptExport.selection');
    if (kind === 'session') return t('transcriptExport.session');
    return t('transcriptExport.everything');
}

type ExportStepId = 'read' | 'format' | 'save';

/** The steps each scope goes through; a selection is already in memory, so it starts at formatting. */
const SCOPE_STEPS: Readonly<Record<ScopeKind, readonly ExportStepId[]>> = {
    selection: ['format', 'save'],
    session: ['read', 'format', 'save'],
    // The archive is written while the sessions are read, so zipping is part of saving it.
    everything: ['read', 'save'],
};

const JOB_STEP: Readonly<Record<TranscriptExportStep['step'], ExportStepId>> = {
    reading: 'read',
    formatting: 'format',
    saving: 'save',
};

function exportStepLabel(id: ExportStepId, scope: ScopeKind, format: TranscriptExportFormat): string {
    if (id === 'read') return scope === 'everything' ? t('transcriptExport.stepReadEverything') : t('transcriptExport.stepReadSession');
    if (id === 'format') return t('transcriptExport.stepFormat', { format: format === 'json' ? t('transcriptExport.formatJson') : t('transcriptExport.formatMarkdown') });
    return scope === 'everything' ? t('transcriptExport.stepSaveArchive') : t('transcriptExport.stepSaveFile');
}

/**
 * The running export as steps. The current step is the one the job last reported (and the scope's
 * first before it reports any); counts and bars come only from the job's own progress.
 */
function exportSteps(scope: ScopeKind, format: TranscriptExportFormat, phase: Extract<Phase, { kind: 'running' }>): readonly StepProgressItem[] {
    const ids = SCOPE_STEPS[scope];
    const reported = phase.step ? ids.indexOf(JOB_STEP[phase.step.step]) : -1;
    const currentIndex = Math.max(0, reported);
    const { done, failed } = phase.progress;
    const { total } = phase;
    return ids.map((id, index): StepProgressItem => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending';
        let caption: string | null = null;
        let fraction: number | null = null;
        if (id === 'read' && scope === 'everything') {
            const determinate = total !== null && total > 0 && done <= total;
            caption = [
                determinate ? t('transcriptExport.progressOf', { done, total }) : t('transcriptExport.progressCount', { count: done }),
                failed > 0 ? t('transcriptExport.progressFailed', { count: failed }) : null,
            ].filter(Boolean).join(' · ');
            fraction = determinate ? done / total : null;
        } else if (id === 'read' && phase.step?.step === 'reading' && phase.step.total !== null && phase.step.total > 0) {
            fraction = phase.step.loaded / phase.step.total;
        }
        return {
            id,
            label: exportStepLabel(id, scope, format),
            state,
            testID: `export-step-${id}`,
            caption,
            progress: fraction === null ? null : { fraction, testID: 'export-sheet-progress-bar' },
        };
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : t('errors.unknownError');
}

/**
 * The one export surface (plans program, lab round 3 "Export"): this session, the selected
 * messages, or everything, as Markdown or JSON, with or without subagent transcripts. The work runs
 * on this device; everything shows live progress and ends with a retry of only the sessions that
 * could not be read. Closing the sheet cancels a run in flight.
 */
export function ExportSheet(props: ExportSheetProps) {
    const { theme } = useUnistyles();
    const selectedMessages = props.selectedMessages ?? null;
    const scopes = React.useMemo(() => {
        const available: ScopeKind[] = [];
        if (props.sessionId && selectedMessages && selectedMessages.length > 0) available.push('selection');
        if (props.sessionId) available.push('session');
        available.push('everything');
        return available;
    }, [props.sessionId, selectedMessages]);
    const [scope, setScope] = React.useState<ScopeKind>(scopes.includes(props.initialScope) ? props.initialScope : scopes[0]!);
    const [format, setFormat] = React.useState<TranscriptExportFormat>('markdown');
    const [includeSubagents, setIncludeSubagents] = React.useState(true);
    const [phase, setPhase] = React.useState<Phase>(CHOOSE);
    const runRef = React.useRef<AbortController | null>(null);

    // Closing the sheet mid-run cancels the run; nothing is saved.
    React.useEffect(() => () => runRef.current?.abort(), []);

    const start = React.useCallback((retrySessionIds?: readonly string[]) => {
        runRef.current?.abort();
        const controller = new AbortController();
        runRef.current = controller;
        const jobScope: TranscriptExportScope = scope === 'everything'
            ? { kind: 'everything', ...(retrySessionIds ? { retrySessionIds } : {}) }
            : scope === 'selection'
                ? { kind: 'selection', sessionId: props.sessionId!, messages: selectedMessages ?? [] }
                : { kind: 'session', sessionId: props.sessionId! };
        // The bar needs a known end: the failed ids on a retry, the opener's count otherwise.
        const total = scope !== 'everything' ? null : retrySessionIds ? retrySessionIds.length : props.totalSessions ?? null;
        let latest = NO_PROGRESS;
        setPhase({ kind: 'running', progress: NO_PROGRESS, total });
        runTranscriptExport({
            scope: jobScope,
            format,
            includeSubagents,
            dialogTitle: scopeTitle(scope),
            signal: controller.signal,
            onStepProgress: (step) => {
                if (!controller.signal.aborted) setPhase({ kind: 'running', progress: latest, total, step });
            },
            onProgress: (progress) => {
                latest = progress;
                if (!controller.signal.aborted && scope === 'everything') setPhase({ kind: 'running', progress, total });
            },
        }).then(
            (result) => {
                if (controller.signal.aborted) return;
                setPhase({ kind: 'done', result, exported: latest.done - latest.failed });
            },
            (error: unknown) => {
                if (controller.signal.aborted) return;
                setPhase({ kind: 'error', message: errorMessage(error) });
            },
        );
    }, [format, includeSubagents, props.sessionId, props.totalSessions, scope, selectedMessages]);

    const cancelRun = React.useCallback(() => {
        runRef.current?.abort();
        runRef.current = null;
        setPhase(CHOOSE);
    }, []);

    const title = phase.kind === 'done' ? t('transcriptExport.readyTitle') : scopeTitle(scope);
    const subtitle = phase.kind === 'done' ? t('transcriptExport.readySubtitle') : t('transcriptExport.privacyLine');
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        subtitle,
        testID: 'export-sheet',
        bodyScroll: 'auto' as const,
        dimensions: { width: 540, maxHeightRatio: 0.9, size: 'dialog' as const },
    }), [subtitle, title]);
    useModalCardChrome(props.setChrome, chrome);

    if (phase.kind === 'running') {
        return (
            <View style={styles.body} testID="export-sheet-running">
                <StepProgressList testID="export-sheet-steps" steps={exportSteps(scope, format, phase)} />
                <View style={styles.actions}>
                    <RoundButton size="normal" display="outline" title={t('common.cancel')} onPress={cancelRun} testID="export-sheet-cancel-run" />
                </View>
            </View>
        );
    }

    if (phase.kind === 'done') {
        const failedIds = phase.result.failedSessionIds;
        return (
            <View style={styles.body} testID="export-sheet-done">
                <View style={[styles.file, { borderColor: theme.colors.border.default }]}>
                    <Icon name="file" size={18} color={theme.colors.text.secondary} />
                    <Text style={styles.fileName} numberOfLines={1}>{phase.result.fileName}</Text>
                    <Text style={[styles.caption, Typography.tabular()]}>{formatByteSize(phase.result.byteCount)}</Text>
                </View>
                {scope === 'everything' ? (
                    <Text style={styles.caption}>{t('transcriptExport.progressCount', { count: phase.exported })}</Text>
                ) : null}
                {failedIds.length > 0 ? (
                    <View style={styles.failed} testID="export-sheet-failed">
                        <Text style={styles.failedText}>{t('transcriptExport.failedSummary', { count: failedIds.length })}</Text>
                        <RoundButton size="small" display="outline" title={t('transcriptExport.retry')} onPress={() => start(failedIds)} testID="export-sheet-retry-failed" />
                    </View>
                ) : null}
                <View style={styles.actions}>
                    <RoundButton size="normal" display="contrast" title={t('common.done')} onPress={props.onClose} testID="export-sheet-done-button" />
                </View>
            </View>
        );
    }

    return (
        <View style={styles.body} testID="export-sheet-choose">
            {scopes.length > 1 ? (
                <View style={styles.field}>
                    <Text style={styles.label}>{t('transcriptExport.scopeLabel')}</Text>
                    <SegmentedTabBar
                        testIDPrefix="export-scope"
                        tabs={scopes.map((kind) => ({
                            id: kind,
                            label: kind === 'selection'
                                ? t('transcriptExport.scopeSelection', { count: selectedMessages?.length ?? 0 })
                                : kind === 'session' ? t('transcriptExport.scopeSession') : t('transcriptExport.scopeEverything'),
                        }))}
                        activeTabId={scope}
                        onSelectTab={setScope}
                    />
                </View>
            ) : null}
            <View style={styles.field}>
                <Text style={styles.label}>{t('transcriptExport.formatLabel')}</Text>
                <SegmentedTabBar
                    testIDPrefix="export-format"
                    tabs={[
                        { id: 'markdown', label: t('transcriptExport.formatMarkdown') },
                        { id: 'json', label: t('transcriptExport.formatJson') },
                    ]}
                    activeTabId={format}
                    onSelectTab={setFormat}
                />
                <Text style={styles.caption}>
                    {format === 'json' ? t('transcriptExport.formatJsonHint') : t('transcriptExport.formatMarkdownHint')}
                    {scope === 'everything' ? ` ${t('transcriptExport.zippedHint')}` : ''}
                </Text>
            </View>
            {/* A plain row on the sheet's own inset: an ItemGroup brings its own page margin. */}
            <View style={[styles.row, { borderColor: theme.colors.border.default }]} testID="export-subagents">
                <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{t('transcriptExport.subagents')}</Text>
                    <Text style={styles.caption}>{t('transcriptExport.subagentsHint')}</Text>
                </View>
                <Switch
                    value={includeSubagents}
                    onValueChange={setIncludeSubagents}
                    accessibilityLabel={t('transcriptExport.subagents')}
                />
            </View>
            {phase.kind === 'error' ? (
                <Text style={styles.error} testID="export-sheet-error">{t('transcriptExport.errorLine', { message: phase.message })}</Text>
            ) : null}
            <View style={styles.actions}>
                <RoundButton size="normal" display="inverted" title={t('common.cancel')} onPress={props.onClose} />
                <RoundButton
                    size="normal"
                    display="contrast"
                    title={phase.kind === 'error' ? t('common.retry') : t('transcriptExport.export')}
                    onPress={() => start()}
                    testID="export-sheet-start"
                />
            </View>
        </View>
    );
}

export type ShowExportSheetParams = Omit<ExportSheetProps, keyof CustomModalInjectedProps>;

export function showExportSheet(params: ShowExportSheetParams): void {
    Modal.show({ component: ExportSheet, props: params });
}

const styles = StyleSheet.create((theme) => ({
    body: {
        gap: 18,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    field: {
        gap: 8,
    },
    label: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    caption: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
    },
    rowText: {
        flex: 1,
        gap: 2,
    },
    rowTitle: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    file: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 12,
        borderWidth: 1,
        backgroundColor: theme.colors.surface.inset,
    },
    fileName: {
        ...Typography.mono('semiBold'),
        flex: 1,
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    failed: {
        gap: 10,
        alignItems: 'flex-start',
    },
    failedText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    error: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.state.danger.foreground,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 10,
    },
}));
