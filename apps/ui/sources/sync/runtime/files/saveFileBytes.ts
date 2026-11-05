import { Platform } from 'react-native';

import { t } from '@/text';

import { downloadWebFile } from './downloadWebFile';
import { createNativeCacheFileSink, shareNativeCacheFile, type NativeCacheFileSink } from './nativeCacheFileSink';
import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';
import { createDesktopDownloadFileSink, openInDefaultApp } from './openInDefaultApp';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

/** Platform effect for files.save; Action admission and source acquisition happen above this boundary. */
export const saveClientFile: NonNullable<ActionExecutorDeps['saveClientFile']> = async ({ bytes, fileName, signal }) => {
    try {
        const status = await saveFileBytes({ bytes, fileName, mimeType: 'text/plain', UTI: 'public.plain-text',
            action: 'save', isCurrent: () => signal?.aborted !== true });
        return { status };
    } catch {
        return { ok: false, errorCode: 'file_save_unavailable', error: 'file_save_unavailable' };
    }
};

type FileHandoffInput = Readonly<{
    fileName: string;
    mimeType: string;
    dialogTitle?: string;
    UTI?: string;
    isCurrent?: () => boolean;
    onHandoff?: () => void;
    action?: 'save' | 'open' | 'share';
}>;

export function canOpenFileInDefaultApp(): boolean {
    return Platform.OS === 'android' || Platform.OS === 'ios' || desktopHostKind() === 'tauri';
}

/**
 * Hands finished bytes to the person: a browser download on web, the platform share sheet elsewhere.
 * Resolves `canceled` when `isCurrent` turned false before the hand-off; throws when sharing is unavailable.
 */
export async function saveFileBytes(input: FileHandoffInput & Readonly<{ bytes: Uint8Array }>): Promise<'saved' | 'canceled'> {
    if (Platform.OS === 'web') {
        if (input.isCurrent?.() === false) return 'canceled';
        input.onHandoff?.();
        downloadWebFile(new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName, async () => {});
        return 'saved';
    }
    return saveNativeFile(input, sink => sink.writeBytes(input.bytes));
}

/** Reuses completed preview bytes; native file copies stay outside the JS heap. */
export async function saveFileUri(input: FileHandoffInput & Readonly<{ uri: string }>): Promise<'saved' | 'canceled'> {
    if (input.isCurrent?.() === false) return 'canceled';
    if (Platform.OS === 'web') {
        const blob = await (await fetch(input.uri)).blob();
        if (input.isCurrent?.() === false) return 'canceled';
        if (input.action === 'open' && desktopHostKind() === 'tauri') {
            return saveNativeFile(input, async sink => sink.writeBytes(new Uint8Array(await blob.arrayBuffer())));
        }
        input.onHandoff?.();
        downloadWebFile(blob, input.fileName, async () => {});
        return 'saved';
    }
    if (!/^(file|content):/i.test(input.uri)) {
        // Plugin-provided direct images may be data/remote URIs rather than preview cache files.
        const bytes = new Uint8Array(await (await fetch(input.uri)).arrayBuffer());
        return saveFileBytes({ ...input, bytes });
    }
    return saveNativeFile(input, async sink => {
        await sink.close();
        const { File } = await import('expo-file-system');
        const destination = new File(sink.fileUri);
        destination.delete();
        new File(input.uri).copy(destination);
    });
}

async function saveNativeFile(input: FileHandoffInput, fill: (sink: NativeCacheFileSink) => Promise<void>): Promise<'saved' | 'canceled'> {
    const desktopOpening = Platform.OS === 'web' && input.action === 'open' && desktopHostKind() === 'tauri';
    const sink = desktopOpening
        ? { ok: true as const, ...await createDesktopDownloadFileSink({ fileName: input.fileName, invoke: invokeDesktopHost }) }
        : await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: input.fileName });
    if (!sink.ok) throw new Error(sink.error);
    let retainCacheFile = false;
    try {
        await fill(sink);
        await sink.close();
        if (desktopOpening) {
            if (input.isCurrent?.() === false) return 'canceled';
            input.onHandoff?.();
            await openInDefaultApp({ path: sink.fileUri, invoke: invokeDesktopHost });
            retainCacheFile = true;
            return 'saved';
        }
        const shared = await shareNativeCacheFile({
            fileUri: sink.fileUri, name: input.fileName, mimeType: input.mimeType, isCurrent: input.isCurrent,
            action: input.action, onHandoff: input.onHandoff,
            dialogTitle: input.dialogTitle, UTI: input.UTI,
        });
        if (shared.status === 'canceled') return 'canceled';
        if (shared.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
        retainCacheFile = shared.retainCacheFile;
        return 'saved';
    } finally {
        if (!retainCacheFile) await sink.cleanup();
    }
}
