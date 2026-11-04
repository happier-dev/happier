import { Platform } from 'react-native';

import { Modal } from '@/modal';
import { t } from '@/text';
import { beginClipboardWriteFromUi, getClipboardStringSafe, setClipboardStringSafe } from '@/utils/ui/clipboard';

type RemoteClipboard = Readonly<{
    read(action: 'copy' | 'cut'): Promise<string>;
    write(text: string): Promise<void>;
}>;
export type RemoteViewerClipboardResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
export type RemoteViewerClipboardShortcut = (action: 'copy' | 'cut' | 'paste') => Promise<RemoteViewerClipboardResult>;

/** Browser and Computer share the local OS boundary, including WebKit's gesture-bound write. */
export async function transferRemoteViewerClipboard(action: 'copy' | 'cut' | 'paste', remote: RemoteClipboard): Promise<void> {
    const webWrite = action !== 'paste' && Platform.OS === 'web' ? beginClipboardWriteFromUi('text/plain') : null;
    try {
        if (action === 'paste') {
            const text = await getClipboardStringSafe();
            if (text === null) throw new Error('clipboard_unavailable');
            await remote.write(text);
        } else {
            const text = await remote.read(action);
            const copied = webWrite ? await webWrite.write(new Blob([text], { type: 'text/plain' })) : await setClipboardStringSafe(text);
            if (!copied) throw new Error('clipboard_unavailable');
        }
    } catch (error) {
        await webWrite?.refuse();
        throw error;
    }
}

export function createRemoteViewerClipboardShortcut(remote: RemoteClipboard): RemoteViewerClipboardShortcut {
    return async action => {
        try {
            await transferRemoteViewerClipboard(action, remote);
            return { ok: true };
        } catch (error) {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
            return { ok: false, reason: error instanceof Error ? error.message : 'clipboard_unavailable' };
        }
    };
}
