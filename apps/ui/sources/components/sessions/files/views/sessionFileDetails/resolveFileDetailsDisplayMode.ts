import type { FileDisplayMode } from '@/components/sessions/files/file/FileActionToolbar';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function resolveFileDetailsDisplayMode(input: Readonly<{
    persistedEditing: boolean;
    deepLinkSource: ReviewCommentSource | null;
    hasDiffContent: boolean;
    hasFileContent: boolean;
    markdownPreviewAvailable: boolean;
}>): FileDisplayMode {
    if (input.deepLinkSource === 'file' && input.hasFileContent) return 'file';
    if (input.deepLinkSource === 'diff' && input.hasDiffContent) return 'diff';
    if (input.persistedEditing && input.hasFileContent) return 'file';
    if (input.hasDiffContent) return 'diff';
    if (input.markdownPreviewAvailable) return 'markdown';
    if (input.hasFileContent) return 'file';
    return 'diff';
}
