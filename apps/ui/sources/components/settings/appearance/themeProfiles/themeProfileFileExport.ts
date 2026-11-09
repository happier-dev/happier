import { t } from '@/text';
import { saveFileBytes } from '@/sync/runtime/files/saveFileBytes';

export async function exportThemeProfileFile(fileName: string, json: string): Promise<void> {
    await saveFileBytes({ fileName, bytes: new TextEncoder().encode(json), mimeType: 'application/json', dialogTitle: t('settingsAppearance.themeProfiles.exportProfile') });
}
