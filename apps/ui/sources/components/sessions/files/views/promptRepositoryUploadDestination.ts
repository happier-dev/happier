import { Modal } from '@/modal';
import { t } from '@/text';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

function normalizeRepositoryUploadDestination(raw: string): string {
    let normalized = raw.trim();
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!normalized || normalized === '.') return '';
    return normalized;
}

export async function promptRepositoryUploadDestination(currentDestinationDir: string): Promise<string | null> {
    const raw = await Modal.prompt(
        t('settingsAttachments.workspaceDirectory.uploadsDirectory.promptTitle'),
        t('settingsAttachments.workspaceDirectory.uploadsDirectory.promptMessage'),
        {
            placeholder: t('files.projectRoot'),
            defaultValue: currentDestinationDir,
        },
    );
    if (typeof raw !== 'string') return null;

    const normalized = normalizeRepositoryUploadDestination(raw);
    if (!normalized) return '';

    if (!isSafeWorkspaceRelativePath(normalized)) {
        Modal.alert(
            t('settingsAttachments.workspaceDirectory.uploadsDirectory.invalidDirectoryTitle'),
            t('settingsAttachments.workspaceDirectory.uploadsDirectory.invalidDirectoryMessage'),
        );
        return null;
    }

    return normalized;
}
