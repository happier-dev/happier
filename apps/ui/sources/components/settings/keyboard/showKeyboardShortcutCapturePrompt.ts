import { Modal } from '@/modal';

import {
    KeyboardShortcutCapturePromptModal,
    type KeyboardShortcutCapturePromptModalProps,
} from './KeyboardShortcutCapturePromptModal';

export async function showKeyboardShortcutCapturePrompt(
    params: Omit<
        KeyboardShortcutCapturePromptModalProps,
        'onClose' | 'onResolve' | 'setChrome'
    >,
): Promise<string | null> {
    return await new Promise((resolve) => {
        let settled = false;
        const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        Modal.show({
            component: KeyboardShortcutCapturePromptModal,
            props: {
                ...params,
                onResolve: settle,
            },
            onRequestClose: () => settle(null),
            closeOnBackdrop: true,
        });
    });
}
