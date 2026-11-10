import { t } from '@/text';

/**
 * One presentation owner for transcript-source availability across Universal
 * Search and contextual Session-list Search.
 */
export function transcriptSearchUnavailableHint(reason: string | null | undefined): string {
    if (reason === 'home_indexing') return t('sessionsList.transcriptSearchHomeIndexing');
    if (reason === 'daemon_no_target' || reason === 'daemon_unavailable') return t('errors.daemonUnavailableBody');
    if (reason === 'home_unavailable') return t('sessionsList.transcriptSearchHomeUnavailable');
    if (reason === 'home_unknown') return t('sessionsList.transcriptSearchHomeUnknown');
    return t('memorySearchSettings.disabled.footer');
}
