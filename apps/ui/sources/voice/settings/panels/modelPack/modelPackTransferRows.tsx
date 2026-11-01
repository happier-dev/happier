import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { parseDownloadProgress } from '@/voice/downloads/downloadProgress';
import { ModelPackInsufficientStorageError } from '@/voice/modelPacks/installer/errors';

/**
 * Row presentation shared by the native model pack settings screens (Kokoro TTS, streaming STT), so
 * both describe downloads, failures and leftover partial downloads the same way.
 */

export type ModelPackRowStatus = 'idle' | 'downloading' | 'ready' | 'error';

export type ModelPackRowPresentation = Readonly<{
    detail: string;
    /** `null` keeps the row's own explanatory subtitle. */
    subtitle: React.ReactNode | null;
}>;

const styles = StyleSheet.create({
    bar: {
        marginTop: 6,
        marginBottom: 4,
    },
});

/** Bytes a not-installed pack left on disk (a failed or interrupted download); 0 when installed. */
export function readPartialDownloadBytes(summary: Readonly<{ installed: boolean; partialBytes?: number }> | null): number {
    if (!summary || summary.installed) return 0;
    return summary.partialBytes ?? 0;
}

function ModelPackProgressBar(props: Readonly<{ progress: number; accessibilityLabel: string }>) {
    const { theme } = useUnistyles();
    return <MeterBar tone="neutral" height={4} animated fillFraction={props.progress}
        fillColor={theme.colors.text.link}
        progressAccessibilityLabel={props.accessibilityLabel} />;
}

function progressSubtitle(
    phase: 'download' | 'verify',
    fraction: number,
    accessibilityLabel: string,
    line: string,
): React.ReactNode {
    // Item renders the string with its own subtitle typography below the bar.
    return (
        <>
            <View style={styles.bar}>
                {/* The bar's meaning changes between phases; a fresh bar starts at the new value instead of
                    gliding backward from a full download bar to the verification still in progress. */}
                <ModelPackProgressBar key={phase} progress={fraction} accessibilityLabel={accessibilityLabel} />
            </View>
            {line}
        </>
    );
}

function describeDownloading(progress: unknown): ModelPackRowPresentation {
    const info = parseDownloadProgress(progress);
    const detail = info.percent != null ? `${info.percent}%` : t('settingsVoice.local.kokoro.modelStatus.downloading');
    if (!info.bytes) return { detail, subtitle: null };
    const total = formatByteSize(info.bytes.total);
    // Every byte has arrived but files are still being hashed: large files take a while to check, so show
    // that work instead of a download stuck at 100%.
    if (info.files && info.verifiedBytes != null && info.bytes.loaded >= info.bytes.total && info.files.done < info.files.total) {
        return {
            detail: t('settingsVoice.local.modelPackDownload.verifyingDetail'),
            subtitle: progressSubtitle(
                'verify',
                info.verifiedBytes / info.bytes.total,
                t('settingsVoice.local.modelPackDownload.verifyingAccessibilityLabel'),
                t('settingsVoice.local.modelPackDownload.verifyingProgress', {
                    verified: formatByteSize(info.verifiedBytes), total, filesDone: info.files.done, filesTotal: info.files.total,
                }),
            ),
        };
    }
    const loaded = formatByteSize(info.bytes.loaded);
    const line = info.files
        ? t('settingsVoice.local.modelPackDownload.progressWithFiles', { loaded, total, filesDone: info.files.done, filesTotal: info.files.total })
        : t('settingsVoice.local.modelPackDownload.progress', { loaded, total });
    return {
        detail,
        subtitle: progressSubtitle(
            'download',
            info.bytes.loaded / info.bytes.total,
            t('settingsVoice.local.modelPackDownload.progressAccessibilityLabel'),
            line,
        ),
    };
}

/**
 * The model row while a download runs, after it failed, or when an earlier one was left unfinished.
 * Returns `null` when the screen's own installed / not-downloaded copy applies.
 */
export function resolveModelPackTransferRow(params: Readonly<{
    status: ModelPackRowStatus;
    progress: unknown;
    partialBytes: number;
}>): ModelPackRowPresentation | null {
    if (params.status === 'downloading') return describeDownloading(params.progress);
    const size = formatByteSize(params.partialBytes);
    if (params.status === 'error') {
        return {
            detail: t('settingsVoice.local.modelPackDownload.failedDetail'),
            subtitle: params.partialBytes > 0
                ? t('settingsVoice.local.modelPackDownload.failedResumableSubtitle', { size })
                : t('settingsVoice.local.modelPackDownload.failedSubtitle'),
        };
    }
    if (params.partialBytes > 0) {
        return {
            detail: t('settingsVoice.local.modelPackDownload.incompleteDetail'),
            subtitle: t('settingsVoice.local.modelPackDownload.incompleteSubtitle', { size }),
        };
    }
    return null;
}

/** The remove row when only a partial download is on disk; `null` when there is none. */
export function resolvePartialDownloadRemoveRow(partialBytes: number): ModelPackRowPresentation | null {
    if (partialBytes <= 0) return null;
    return {
        detail: formatByteSize(partialBytes),
        subtitle: t('settingsVoice.local.modelPackDownload.discardSubtitle'),
    };
}

export function confirmDiscardPartialDownload(partialBytes: number): Promise<boolean> {
    return Modal.confirm(
        t('settingsVoice.local.modelPackDownload.discardConfirmTitle'),
        t('settingsVoice.local.modelPackDownload.discardConfirmBody', { size: formatByteSize(partialBytes) }),
        { confirmText: t('common.delete'), destructive: true },
    );
}

/** The reason a download or update failed, in the user's language when the installer knows the cause. */
export function describeModelPackInstallError(error: unknown): string {
    if (error instanceof ModelPackInsufficientStorageError) {
        return t('settingsVoice.local.modelPackDownload.insufficientStorage', {
            required: formatByteSize(error.requiredBytes),
            available: formatByteSize(error.availableBytes),
        });
    }
    return error instanceof Error ? error.message : String(error);
}
