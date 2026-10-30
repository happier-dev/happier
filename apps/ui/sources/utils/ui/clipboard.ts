import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Raw host-facing read: `null` distinguishes a failed platform read from an empty clipboard. */
export async function getClipboardStringSafe(): Promise<string | null> {
    try {
        return await Clipboard.getStringAsync();
    } catch {
        return null;
    }
}

export async function getClipboardStringTrimmedSafe(): Promise<string> {
    return (await getClipboardStringSafe())?.trim() ?? '';
}

export async function setClipboardStringSafe(value: string): Promise<boolean> {
    try {
        const copied = Platform.OS === 'web'
            ? await setClipboardStringOnWeb(value)
            : await Clipboard.setStringAsync(value);
        if (!copied) console.warn('Clipboard write was refused by the platform.');
        return copied;
    } catch {
        console.warn('Clipboard write failed.');
        return false;
    }
}

async function setClipboardStringOnWeb(value: string): Promise<boolean> {
    try {
        // Invoke before any await to preserve WebKit's user-gesture requirement.
        await navigator.clipboard.writeText(value);
        return true;
    } catch {
        // Preserve Expo's legacy fallback, but honor execCommand's actual result:
        // Expo Clipboard 55.0.11 returns true even when this write is refused.
        const textField = document.createElement('textarea');
        textField.value = value;
        document.body.appendChild(textField);
        try {
            textField.select();
            return document.execCommand('copy');
        } finally {
            document.body.removeChild(textField);
        }
    }
}

/**
 * UI copies share native Action admission. Web is the platform exception: WebKit requires
 * writeText in the click/touch call stack, which async Action loading/admission cannot retain.
 * Keep that write here, before any await; never pre-copy ahead of native admission.
 * https://webkit.org/blog/10855/async-clipboard-api/#security-and-privacy
 */
export async function writeClipboardStringFromUi(value: string, execute: (
    actionId: 'clipboard.write', input: Readonly<{ text: string }>,
) => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> {
    if (Platform.OS !== 'web') return execute('clipboard.write', { text: value });
    return await setClipboardStringSafe(value)
        ? { ok: true, result: { status: 'copied' } }
        : { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' };
}

/** A PNG (standard base64, no data-URI prefix) onto the system clipboard; false when the platform refuses. */
export async function setClipboardImageSafe(base64Png: string): Promise<boolean> {
    try {
        await Clipboard.setImageAsync(base64Png);
        return true;
    } catch {
        return false;
    }
}
