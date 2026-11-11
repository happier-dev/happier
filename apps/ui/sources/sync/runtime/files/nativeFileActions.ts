import { t } from '@/text';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type AndroidFileAction = 'save' | 'open' | 'share';

type AndroidFileActionsModule = {
    saveFile: (uri: string, name: string) => Promise<{ canceled: boolean; uri?: string }>;
    openFile: (uri: string, name: string) => Promise<void>;
    shareFile: (uri: string, name: string, mimeType?: string | null, dialogTitle?: string) => Promise<void>;
};

export async function performAndroidFileAction(input: Readonly<{
    fileUri: string;
    name: string;
    action: AndroidFileAction;
    mimeType?: string;
    dialogTitle?: string;
}>): Promise<{ canceled: boolean }> {
    const native = requireOptionalNativeModule<AndroidFileActionsModule>('HappierFileActions');
    if (!native) throw new Error(t('files.androidFileActionsUnavailable'));
    if (input.action === 'save') return await native.saveFile(input.fileUri, input.name);
    if (input.action === 'open') await native.openFile(input.fileUri, input.name);
    else if (input.dialogTitle !== undefined) await native.shareFile(input.fileUri, input.name, input.mimeType ?? null, input.dialogTitle);
    else if (input.mimeType !== undefined) await native.shareFile(input.fileUri, input.name, input.mimeType);
    else await native.shareFile(input.fileUri, input.name);
    return { canceled: false };
}

type IosFileActionsModule = {
    previewFile: (uri: string) => Promise<{ status: 'dismissed' | 'unsupported' }>;
};

/**
 * Quick Look for a local file; settles when the person dismisses it. `unavailable` is an installed
 * app built before this module (JS updates reach it first), so the caller keeps the share sheet.
 */
export async function previewIosFile(fileUri: string): Promise<'dismissed' | 'unsupported' | 'unavailable'> {
    const native = requireOptionalNativeModule<IosFileActionsModule>('HappierFileActions');
    if (!native) return 'unavailable';
    return (await native.previewFile(fileUri)).status;
}
