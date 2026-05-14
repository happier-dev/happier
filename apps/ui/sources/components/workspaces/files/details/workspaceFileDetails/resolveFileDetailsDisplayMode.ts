import type { FileDisplayMode } from '@/components/workspaces/files/file/FileActionToolbar';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function resolveFileDetailsDisplayMode(input: Readonly<{
    persistedEditing: boolean;
    deepLinkSource: ReviewCommentSource | null;
    hasRenderableDiff: boolean;
    hasFileContent: boolean;
    markdownPreviewAvailable: boolean;
}>): FileDisplayMode {
    if (input.deepLinkSource === 'file' && input.hasFileContent) return 'file';
    if (input.deepLinkSource === 'diff' && input.hasRenderableDiff) return 'diff';
    if (input.persistedEditing && input.hasFileContent) return 'file';
    if (input.hasRenderableDiff) return 'diff';
    if (input.markdownPreviewAvailable) return 'markdown';
    if (input.hasFileContent) return 'file';
    return 'diff';
}
