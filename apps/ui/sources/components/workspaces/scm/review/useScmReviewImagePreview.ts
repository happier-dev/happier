import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    useSessionImagePreview,
    type SessionImagePreviewState,
} from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';

export type ScmReviewImagePreviewState = SessionImagePreviewState;

export type ScmReviewImagePreviewSource =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'workspace'; scopeId: string; scope: WorkspaceScopeBase }>;

export function useScmReviewImagePreview(input: Readonly<{
    source: ScmReviewImagePreviewSource;
    filePath: string;
    enabled: boolean;
    cacheKey?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
}>): ScmReviewImagePreviewState {
    return useSessionImagePreview({
        sessionId: input.source.kind === 'session' ? input.source.sessionId : input.source.scopeId,
        filePath: input.filePath,
        enabled: input.enabled,
        cacheKey: input.cacheKey ?? null,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        workspaceScope: input.source.kind === 'workspace' ? input.source.scope : null,
        cacheScopeId: input.source.kind === 'workspace' ? input.source.scopeId : null,
    });
}
