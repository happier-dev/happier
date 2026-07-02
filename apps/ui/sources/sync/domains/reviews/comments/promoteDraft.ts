import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type {
    ReviewCommentCreateRequestV1,
    ReviewCommentCreateResponseV1,
} from '@happier-dev/protocol';

import { mapReviewCommentDraftAnchorToDurableV1Target } from '@/sync/domains/input/reviewComments/anchors/reviewCommentDraftAnchor';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function sha256Json(value: unknown): string {
    return `sha256:${bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))))}`;
}

function hasBidiControls(lines: readonly string[]): boolean {
    return lines.some((line) => BIDI_CONTROL_RE.test(line));
}

function isLikelyMinified(lines: readonly string[]): boolean {
    if (lines.length === 0) return false;
    const joined = lines.join('\n');
    if (joined.length < 2000) return false;
    return joined.length / lines.length > 500 && lines.length / Math.max(joined.length, 1) < 0.003;
}

export function buildDurableReviewCommentCreateRequestFromDraft(params: Readonly<{
    projectId: string;
    draft: ReviewCommentDraft;
    clientMutationId: string;
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    engineId?: string;
    authorDeviceId?: string;
    clientLamport?: number;
}>): ReviewCommentCreateRequestV1 {
    const anchor = mapReviewCommentDraftAnchorToDurableV1Target({
        filePath: params.draft.filePath,
        anchor: params.draft.anchor,
    });
    if (!anchor) {
        throw new Error('Review comment draft cannot be promoted without a durable anchor target');
    }

    const allLines = [
        ...params.draft.snapshot.beforeContext,
        ...params.draft.snapshot.selectedLines,
        ...params.draft.snapshot.afterContext,
    ];

    return {
        projectId: params.projectId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        engineId: params.engineId,
        anchor,
        snapshot: {
            kind: 'text',
            selectedLines: [...params.draft.snapshot.selectedLines],
            beforeContext: [...params.draft.snapshot.beforeContext],
            afterContext: [...params.draft.snapshot.afterContext],
            selectedLinesHash: sha256Json(params.draft.snapshot.selectedLines),
            contextWindowHash: sha256Json({
                beforeContext: params.draft.snapshot.beforeContext,
                selectedLines: params.draft.snapshot.selectedLines,
                afterContext: params.draft.snapshot.afterContext,
            }),
            capturedAt: params.draft.createdAt,
            fileLength: allLines.length,
            source: params.draft.source === 'diff' ? 'diffSide' : 'workingTree',
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: hasBidiControls(allLines),
            likelyMinified: isLikelyMinified(allLines),
        },
        body: params.draft.body,
        authorIntent: 'propose',
        clientMutationId: params.clientMutationId,
        authorDeviceId: params.authorDeviceId,
        clientLamport: params.clientLamport,
    };
}

export type SubmitDurableReviewCommentDraftParams = Readonly<{
    projectId: string;
    draft: ReviewCommentDraft;
    clientMutationId: string;
    actions: Readonly<{
        create: (input: ReviewCommentCreateRequestV1) => Promise<ReviewCommentCreateResponseV1>;
    }>;
    onPromoted?: (event: Readonly<{ draftId: string; commentId: string }>) => void;
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    engineId?: string;
    authorDeviceId?: string;
    clientLamport?: number;
}>;

export async function submitDurableReviewCommentDraft(
    params: SubmitDurableReviewCommentDraftParams,
): Promise<ReviewCommentCreateResponseV1> {
    const request = buildDurableReviewCommentCreateRequestFromDraft({
        projectId: params.projectId,
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        runId: params.runId,
        engineId: params.engineId,
        draft: params.draft,
        clientMutationId: params.clientMutationId,
        authorDeviceId: params.authorDeviceId,
        clientLamport: params.clientLamport,
    });
    const response = await params.actions.create(request);
    params.onPromoted?.({
        draftId: params.draft.id,
        commentId: response.comment.id,
    });
    return response;
}
