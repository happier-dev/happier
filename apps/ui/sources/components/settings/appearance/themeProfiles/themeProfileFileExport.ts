import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { t } from '@/text';

export async function downloadThemeJson(fileName: string, json: string): Promise<void> {
    await saveFileBytes({
        name: fileName,
        bytes: new TextEncoder().encode(json),
        mimeType: 'application/json',
        dialogTitle: t('settingsAppearance.themeProfiles.exportProfile'),
    });
}
