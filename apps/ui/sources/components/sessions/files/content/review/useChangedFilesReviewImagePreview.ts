import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { useSessionImagePreview } from '../imagePreview/useSessionImagePreview';

export function useChangedFilesReviewImagePreview(input: Readonly<{
    sessionId: string;
    snapshotSignature?: string | null;
    filePath: string;
    enabled: boolean;
}>) {
    const sessionId = input.sessionId;
    const snapshotSignature =
        typeof input.snapshotSignature === 'string' && input.snapshotSignature.trim().length > 0
            ? input.snapshotSignature.trim()
            : null;
    const filePath = input.filePath;
    const enabled = input.enabled === true;

    return useSessionImagePreview({
        sessionId,
        filePath,
        enabled,
        cacheKey: snapshotSignature,
        mimeType: getImageMimeTypeFromPath(filePath),
        sizeBytes: null,
    });
}
