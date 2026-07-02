import type {
    ReviewCommentAttachEvidenceRequestV1,
    ReviewCommentAttachEvidenceResponseV1,
    ReviewCommentAnchorV1,
    ReviewCommentBulkTransitionRequestV1,
    ReviewCommentBulkTransitionResponseV1,
    ReviewCommentCreateRequestV1,
    ReviewCommentCreateResponseV1,
    ReviewCommentEditRequestV1,
    ReviewCommentEditResponseV1,
    ReviewCommentEvidenceV1,
    ReviewCommentFingerprintV1,
    ReviewFinding,
    ReviewCommentGetRequestV1,
    ReviewCommentGetResponseV1,
    ReviewCommentListRequestV1,
    ReviewCommentListResponseV1,
    ReviewCommentRedactRequestV1,
    ReviewCommentRedactResponseV1,
    ReviewCommentReplyRequestV1,
    ReviewCommentReplyResponseV1,
    ReviewCommentSetDispositionRequestV1,
    ReviewCommentSetDispositionResponseV1,
    ReviewCommentSnapshotV1,
    ReviewCommentTransitionRequestV1,
    ReviewCommentTransitionResponseV1,
    ReviewCommentV1,
} from '@happier-dev/protocol';

export type PluginReviewCommentOperationOptionsV1 = Readonly<{
    signal?: AbortSignal;
}>;

export type PluginReviewCommentCreateRequestV1 = Readonly<ReviewCommentCreateRequestV1>;

export type PluginReviewCommentListRequestV1 = Readonly<
    Omit<ReviewCommentListRequestV1, 'states' | 'includeHistory' | 'limit'> &
    Partial<Pick<ReviewCommentListRequestV1, 'states' | 'includeHistory' | 'limit'>>
>;

export type PluginReviewCommentGetRequestV1 = Readonly<
    Omit<ReviewCommentGetRequestV1, 'includeHistory'> &
    Partial<Pick<ReviewCommentGetRequestV1, 'includeHistory'>>
>;

export type PluginReviewCommentTransitionRequestV1 = Readonly<ReviewCommentTransitionRequestV1>;

export type PluginReviewCommentEditRequestV1 = Readonly<ReviewCommentEditRequestV1>;

export type PluginReviewCommentReplyRequestV1 = Readonly<ReviewCommentReplyRequestV1>;

export type PluginReviewCommentBulkTransitionRequestV1 = Readonly<
    Omit<ReviewCommentBulkTransitionRequestV1, 'evidence'> &
    Partial<Pick<ReviewCommentBulkTransitionRequestV1, 'evidence'>>
>;

export type PluginReviewCommentRedactRequestV1 = Readonly<ReviewCommentRedactRequestV1>;

export type PluginReviewCommentSetDispositionRequestV1 = Readonly<ReviewCommentSetDispositionRequestV1>;

export type PluginReviewCommentAttachEvidenceRequestV1 = Readonly<ReviewCommentAttachEvidenceRequestV1>;

export type PluginReviewCommentResolveSnapshotRequestV1 = Readonly<{
    cwd?: string | null;
    projectId?: string;
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    engineId?: string;
    findingId?: string;
    finding?: ReviewFinding;
    anchor: ReviewCommentAnchorV1;
}>;

export type PluginReviewCommentCreateResultV1 = ReviewCommentCreateResponseV1;
export type PluginReviewCommentListResultV1 = ReviewCommentListResponseV1;
export type PluginReviewCommentGetResultV1 = ReviewCommentGetResponseV1;
export type PluginReviewCommentTransitionResultV1 = ReviewCommentTransitionResponseV1;
export type PluginReviewCommentEditResultV1 = ReviewCommentEditResponseV1;
export type PluginReviewCommentReplyResultV1 = ReviewCommentReplyResponseV1;
export type PluginReviewCommentBulkTransitionResultV1 = ReviewCommentBulkTransitionResponseV1;
export type PluginReviewCommentRedactResultV1 = ReviewCommentRedactResponseV1;
export type PluginReviewCommentSetDispositionResultV1 = ReviewCommentSetDispositionResponseV1;
export type PluginReviewCommentAttachEvidenceResultV1 = ReviewCommentAttachEvidenceResponseV1;
export type PluginReviewCommentResolveSnapshotResultV1 = ReviewCommentSnapshotV1 | null;

export interface PluginReviewCommentsServiceV1 {
    create(
        request: PluginReviewCommentCreateRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentCreateResultV1>;
    list(
        request: PluginReviewCommentListRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentListResultV1>;
    get(
        request: PluginReviewCommentGetRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentGetResultV1>;
    transition(
        request: PluginReviewCommentTransitionRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentTransitionResultV1>;
    edit(
        request: PluginReviewCommentEditRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentEditResultV1>;
    reply(
        request: PluginReviewCommentReplyRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentReplyResultV1>;
    bulkTransition(
        request: PluginReviewCommentBulkTransitionRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentBulkTransitionResultV1>;
    redact(
        request: PluginReviewCommentRedactRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentRedactResultV1>;
    setDisposition(
        request: PluginReviewCommentSetDispositionRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentSetDispositionResultV1>;
    attachEvidence(
        request: PluginReviewCommentAttachEvidenceRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentAttachEvidenceResultV1>;
    resolveSnapshot(
        request: PluginReviewCommentResolveSnapshotRequestV1,
        options?: PluginReviewCommentOperationOptionsV1,
    ): Promise<PluginReviewCommentResolveSnapshotResultV1>;
}

export type {
    ReviewCommentAnchorV1,
    ReviewCommentEvidenceV1,
    ReviewCommentFingerprintV1,
    ReviewCommentSnapshotV1,
    ReviewCommentV1,
};
