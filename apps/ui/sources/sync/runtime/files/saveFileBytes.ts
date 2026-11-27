import { Platform } from 'react-native';

import { t } from '@/text';
import { createNativeCacheFileSink, shareNativeCacheFile } from './nativeCacheFileSink';

type SaveFileParameters = Readonly<{
    name: string;
    mimeType: string;
    dialogTitle: string;
    UTI?: string;
}>;

export async function saveFileStream<T>(input: SaveFileParameters, write: (sink: (bytes: Uint8Array) => Promise<void>) => Promise<T>): Promise<T> {
    if (Platform.OS === 'web') {
        const chunks: Array<Uint8Array<ArrayBuffer>> = [];
        const output = await write(async (bytes) => { chunks.push(new Uint8Array(bytes)); });
        const href = URL.createObjectURL(new Blob(chunks, { type: input.mimeType }));
        try {
            const anchor = document.createElement('a');
            anchor.href = href;
            anchor.download = input.name;
            anchor.click();
        } finally {
            // Preserve the existing browser download handoff before releasing the Blob URL.
            setTimeout(() => URL.revokeObjectURL(href), 1000);
        }
        return output;
    }

    const created = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: input.name });
    if (!created.ok) throw new Error(created.error);
    let retainCacheFile = false;
    try {
        const output = await write(created.sink.writeBytes);
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
        return output;
    } finally {
        if (!retainCacheFile) await created.sink.cleanup();
    }
}

export async function saveFileBytes(input: SaveFileParameters & Readonly<{ bytes: Uint8Array }>): Promise<void> {
    await saveFileStream(input, (write) => write(input.bytes));
}
