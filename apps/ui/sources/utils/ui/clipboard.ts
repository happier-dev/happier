import * as Clipboard from 'expo-clipboard';

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
        return await Clipboard.setStringAsync(value);
    } catch {
        return false;
    }
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
