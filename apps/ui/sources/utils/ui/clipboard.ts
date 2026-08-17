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
        await Clipboard.setStringAsync(value);
        return true;
    } catch {
        return false;
    }
}
