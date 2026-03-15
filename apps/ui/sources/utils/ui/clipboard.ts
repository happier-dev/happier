import * as Clipboard from 'expo-clipboard';

export async function getClipboardStringTrimmedSafe(): Promise<string> {
    try {
        return (await Clipboard.getStringAsync()).trim();
    } catch {
        return '';
    }
}

export async function setClipboardStringSafe(value: string): Promise<boolean> {
    try {
        await Clipboard.setStringAsync(value);
        return true;
    } catch {
        return false;
    }
}
