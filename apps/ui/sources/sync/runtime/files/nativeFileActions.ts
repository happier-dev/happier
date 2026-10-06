import { requireOptionalNativeModule } from 'expo-modules-core';

export type AndroidFileAction = 'save' | 'open' | 'share';

type AndroidFileActionsModule = {
    saveFile: (uri: string, name: string) => Promise<{ canceled: boolean; uri?: string }>;
    openFile: (uri: string, name: string) => Promise<void>;
    shareFile: (uri: string, name: string) => Promise<void>;
};

export async function performAndroidFileAction(input: Readonly<{
    fileUri: string;
    name: string;
    action: AndroidFileAction;
}>): Promise<{ canceled: boolean }> {
    const native = requireOptionalNativeModule<AndroidFileActionsModule>('HappierFileActions');
    if (!native) throw new Error('Android file actions are unavailable in this app build');
    if (input.action === 'save') return await native.saveFile(input.fileUri, input.name);
    if (input.action === 'open') await native.openFile(input.fileUri, input.name);
    else await native.shareFile(input.fileUri, input.name);
    return { canceled: false };
}
