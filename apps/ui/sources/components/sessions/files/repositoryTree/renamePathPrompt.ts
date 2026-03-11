import { Modal } from '@/modal';
import { t } from '@/text';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

export async function renamePathPrompt(params: Readonly<{
    currentPath: string;
}>): Promise<string | null> {
    const currentPath = String(params.currentPath ?? '').trim();
    if (!currentPath) return null;

    const raw = await Modal.prompt(
        t('files.repositoryTree.rename.title'),
        t('files.repositoryTree.rename.body'),
        {
            placeholder: currentPath,
            defaultValue: currentPath,
        }
    );
    if (typeof raw !== 'string') return null;
    const nextPath = raw.trim().replace(/\/+$/g, '');
    if (!nextPath) return null;
    if (nextPath === currentPath) return null;
    if (!isSafeWorkspaceRelativePath(nextPath)) {
        Modal.alert(t('common.error'), t('files.repositoryTree.rename.invalidPath'));
        return null;
    }

    return nextPath;
}

