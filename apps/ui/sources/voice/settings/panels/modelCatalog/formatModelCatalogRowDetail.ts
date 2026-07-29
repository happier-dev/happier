import { t } from '@/text';

import type { ModelCatalogRow, ModelCatalogRowState } from './buildModelCatalogRows';

/** Human-readable label for a row's derived lifecycle state. */
export function modelCatalogStateLabel(state: ModelCatalogRowState): string {
    switch (state) {
        case 'not_installed':
            return t('settingsVoice.local.models.state.notInstalled');
        case 'downloading':
            return t('settingsVoice.local.models.state.downloading');
        case 'installed':
            return t('settingsVoice.local.models.state.installed');
        case 'warming':
            return t('settingsVoice.local.models.state.warming');
        case 'ready':
            return t('settingsVoice.local.models.state.ready');
        case 'evicted':
            return t('settingsVoice.local.models.state.evicted');
        case 'error':
            return t('settingsVoice.local.models.state.error');
        case 'unknown':
            return t('settingsVoice.local.models.state.unknown');
        case 'unsupported':
            return t('settingsVoice.local.daemonInference.states.runtimeUnavailable');
        default:
            return t('settingsVoice.local.models.state.notInstalled');
    }
}

/** Compact human-readable byte size (binary units). */
export function formatResidentMemory(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'] as const;
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    const rounded = unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unitIndex]}`;
}

/**
 * Build the per-row detail string: the lifecycle state, plus download progress
 * while downloading, resident memory when the daemon reports it, and the last
 * error message on failure. Pure (modulo `t`), so it is unit-testable.
 */
export function formatModelCatalogRowDetail(row: ModelCatalogRow): string {
    const parts: string[] = [modelCatalogStateLabel(row.state)];
    if (row.state === 'downloading' && typeof row.progress === 'number') {
        parts.push(`${Math.round(row.progress * 100)}%`);
    }
    if (row.state === 'error' && row.lastError) {
        parts.push(row.lastError);
    }
    if (
        typeof row.residentMemoryBytes === 'number'
        && (row.state === 'ready' || row.state === 'warming' || row.state === 'evicted')
    ) {
        parts.push(t('settingsVoice.local.models.memory', { size: formatResidentMemory(row.residentMemoryBytes) }));
    }
    return parts.join(' • ');
}
