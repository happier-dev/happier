import type {
    WorkspaceAnchorsResolveResponseV1,
} from '@happier-dev/protocol';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    resolveWorkspaceAnchors,
    type ResolveWorkspaceAnchorsInput,
} from '@/sync/ops/workspaceAnchors';

type ReviewCommentAnchorResolver = (
    input: ResolveWorkspaceAnchorsInput
) => Promise<WorkspaceAnchorsResolveResponseV1>;

export async function resolveReviewCommentDraftAnchorsForPrompt(params: Readonly<{
    drafts: readonly ReviewCommentDraft[];
    reviewScope: WorkspaceScopeBase | null;
    resolveAnchors?: ReviewCommentAnchorResolver;
}>): Promise<ReviewCommentDraft[]> {
    if (!params.reviewScope || params.drafts.length === 0) {
        return [...params.drafts];
    }

    const resolver = params.resolveAnchors ?? resolveWorkspaceAnchors;
    try {
        const response = await resolver({
            serverId: params.reviewScope.serverId,
            machineId: params.reviewScope.machineId,
            workspacePath: params.reviewScope.rootPath,
            comments: params.drafts.map((draft) => ({
                id: draft.id,
                filePath: draft.filePath,
                source: draft.source,
                anchor: draft.anchor,
                snapshot: {
                    beforeContext: [...draft.snapshot.beforeContext],
                    selectedLines: [...draft.snapshot.selectedLines],
                    afterContext: [...draft.snapshot.afterContext],
                },
            })),
        });

        if (!response.success) {
            return [...params.drafts];
        }

        const resolutionsById = new Map(response.resolutions.map((resolution) => [resolution.id, resolution]));
        return params.drafts.map((draft) => {
            const anchorResolution = resolutionsById.get(draft.id);
            return anchorResolution ? { ...draft, anchorResolution } : draft;
        });
    } catch {
        return [...params.drafts];
    }
}
