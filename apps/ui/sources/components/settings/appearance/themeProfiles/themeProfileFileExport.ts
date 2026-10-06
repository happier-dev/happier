import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { Platform } from 'react-native';
import { t } from '@/text';

export async function exportThemeProfileFile(fileName: string, json: string): Promise<void> {
    if (
        Platform.OS === 'web'
        && typeof document !== 'undefined'
        && typeof Blob !== 'undefined'
        && typeof URL !== 'undefined'
        && typeof URL.createObjectURL === 'function'
    ) {
        const href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        return;
    }

    const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName });
    if (!sink.ok) throw new Error(sink.error);
    let retainCacheFile = false;
    try {
        await sink.writeBytes(new TextEncoder().encode(json));
        await sink.close();
        const result = await shareNativeCacheFile({
            fileUri: sink.fileUri,
            name: fileName,
            mimeType: 'application/json',
            dialogTitle: t('settingsAppearance.themeProfiles.exportProfile'),
        });
        if (result.status !== 'shared') throw new Error(t('files.fileSharingUnavailable'));
        retainCacheFile = result.retainCacheFile;
    } finally {
        if (!retainCacheFile) await sink.cleanup();
    }
}
