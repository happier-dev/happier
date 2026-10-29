import { Platform } from 'react-native';

import { t } from '@/text';
import { createNativeCacheFileSink, shareNativeCacheFile } from './nativeCacheFileSink';

export async function saveFileBytes(input: Readonly<{
    name: string;
    bytes: Uint8Array;
    mimeType: string;
    dialogTitle: string;
    UTI?: string;
}>): Promise<void> {
    if (Platform.OS === 'web') {
        const href = URL.createObjectURL(new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }));
        try {
            const anchor = document.createElement('a');
            anchor.href = href;
            anchor.download = input.name;
            anchor.click();
        } finally {
            // Preserve the existing browser download handoff before releasing the Blob URL.
            setTimeout(() => URL.revokeObjectURL(href), 1000);
        }
        return;
    }

    const created = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: input.name });
    if (!created.ok) throw new Error(created.error);
    let retainCacheFile = false;
    try {
        await created.sink.writeBytes(input.bytes);
        await created.sink.close();
        const result = await shareNativeCacheFile({
            fileUri: created.sink.fileUri,
            name: input.name,
            mimeType: input.mimeType,
            dialogTitle: input.dialogTitle,
            ...(input.UTI ? { UTI: input.UTI } : {}),
        });
        if (result.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
        if (result.status === 'shared') retainCacheFile = result.retainCacheFile;
    } finally {
        if (!retainCacheFile) await created.sink.cleanup();
    }
}
