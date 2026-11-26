import { Platform } from 'react-native';
import type { RemoteViewerClipboardShortcut } from '@happier-dev/plugin-ui/presentation';

import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { Modal } from '@/modal';
import { t } from '@/text';
import { beginClipboardWriteFromUi, getClipboardStringSafe } from '@/utils/ui/clipboard';

type RemoteClipboard = Readonly<{
    read(action: 'copy' | 'cut'): Promise<string>;
    write(text: string): Promise<void>;
}>;
type ClipboardWriter = (text: string) => Promise<boolean>;

/** Browser and Computer share the local OS boundary, including WebKit's gesture-bound write. */
export async function transferRemoteViewerClipboard(action: 'copy' | 'cut' | 'paste', remote: RemoteClipboard,
    writeClipboard: ClipboardWriter): Promise<void> {
    const webWrite = action !== 'paste' && Platform.OS === 'web' ? beginClipboardWriteFromUi('text/plain') : null;
    try {
        if (action === 'paste') {
            const text = await getClipboardStringSafe();
            if (text === null) throw new Error('clipboard_unavailable');
            await remote.write(text);
        } else {
            const text = await remote.read(action);
            const copied = webWrite ? await webWrite.write(new Blob([text], { type: 'text/plain' })) : await writeClipboard(text);
            if (!copied) throw new Error('clipboard_unavailable');
        }
    } catch (error) {
        await webWrite?.refuse();
        throw error;
    }
}

export function createRemoteViewerClipboardShortcut(remote: RemoteClipboard, writeClipboard: ClipboardWriter): RemoteViewerClipboardShortcut {
    return async action => {
        try {
            await transferRemoteViewerClipboard(action, remote, writeClipboard);
            return { ok: true };
        } catch (error) {
            const failure = readActionFailureEnvelope(error);
            if (failure) {
                const presented = presentActionExecutionFailure(failure, t('errors.operationFailed'), { closedCodesOnly: true });
                alertActionFailure({ reason: presented.reason, code: failure.errorCode, requestId: failure.requestId,
                    context: Object.fromEntries(presented.technicalDetails.filter(line => line.key !== 'code' && line.key !== 'requestId')
                        .map(line => [line.key, line.value])) });
                return { ok: false, reason: failure.errorCode };
            }
            Modal.alert(t('common.error'), t('errors.operationFailed'));
            return { ok: false, reason: error instanceof Error ? error.message : 'clipboard_unavailable' };
        }
    };
}
