import { Modal } from '@/modal';
import { t } from '@/text';

export async function deletePathConfirm(params: Readonly<{
    path: string;
    kind: 'file' | 'directory';
}>): Promise<{ confirmed: boolean; recursive: boolean }> {
    const path = String(params.path ?? '').trim();
    if (!path) return { confirmed: false, recursive: false };

    if (params.kind === 'directory') {
        const confirmed = await Modal.confirm(
            t('files.repositoryTree.deleteFolder.title'),
            t('files.repositoryTree.deleteFolder.body', { path }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('files.repositoryTree.deleteFolder.confirm'),
                destructive: true,
            },
        );
        return { confirmed, recursive: true };
    }

    const confirmed = await Modal.confirm(
        t('files.repositoryTree.deleteFile.title'),
        t('files.repositoryTree.deleteFile.body', { path }),
        {
            cancelText: t('common.cancel'),
            confirmText: t('common.delete'),
            destructive: true,
        },
    );
    return { confirmed, recursive: false };
}

