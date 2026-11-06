import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { getLanguageDisplayNameForCode } from '@/constants/Languages';
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

/**
 * Build the per-row detail string: the lifecycle state, plus download progress
 * while downloading, declared artifact bytes when the daemon reports them, and the last
 * error message on failure. Pure (modulo `t`), so it is unit-testable.
 */
export function formatModelCatalogRowDetail(row: ModelCatalogRow): string {
    const parts: string[] = [formatModelCatalogRowValue(row)];
    if (row.state === 'downloading' && typeof row.progress === 'number') {
        parts.push(`${Math.round(row.progress * 100)}%`);
    }
    if (row.state === 'error' && row.lastError) {
        parts.push(row.lastError);
    }
    if (
        typeof row.loadedArtifactBytes === 'number'
        && (row.state === 'ready' || row.state === 'warming' || row.state === 'evicted')
    ) {
        parts.push(t('settingsVoice.local.models.modelFiles', { size: formatHappierDataBytes(row.loadedArtifactBytes, { kind: 'storage' }) }));
    }
    return parts.join(' • ');
}

const LOADED_STATES: ReadonlySet<ModelCatalogRowState> = new Set(['installed', 'warming', 'ready', 'evicted']);

/**
 * The row's short value: its lifecycle word, or "In use" while the daemon reported a live inference
 * lease on the installed pack. An unknown lease (`null`) never reads as idle or busy.
 */
export function formatModelCatalogRowValue(row: ModelCatalogRow): string {
    if (row.inUse === true && LOADED_STATES.has(row.state)) return t('settingsVoice.local.models.inUse');
    return modelCatalogStateLabel(row.state);
}

/**
 * What the model covers and, until it is on the machine, costs to fetch: its languages and its download. Each fact the catalog
 * does not carry reads as unknown; archive bytes are the download, never disk or memory.
 */
export function formatModelCatalogRowFacts(row: ModelCatalogRow): string {
    const languages = row.languages === null || row.languages.length === 0
        ? t('settingsVoice.local.models.languagesUnknown')
        : row.languages.length <= 2
            ? row.languages.map((code) => getLanguageDisplayNameForCode(code)).join(', ')
            : t('settingsVoice.local.models.languageCount', { count: row.languages.length });
    // Once the model is on the machine there is nothing left to fetch: the row says only what it covers.
    if (LOADED_STATES.has(row.state)) return languages;
    const size = typeof row.archiveBytes === 'number'
        ? t('settingsVoice.local.models.downloadSize', { size: formatHappierDataBytes(row.archiveBytes, { kind: 'storage' }) })
        : t('settingsVoice.local.models.downloadSizeUnknown');
    return `${languages} · ${size}`;
}
