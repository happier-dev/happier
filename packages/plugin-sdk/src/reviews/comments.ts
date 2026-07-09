import { createHash } from 'node:crypto';

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

import { redactBugReportSensitiveText } from '../diagnostics.js';

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

export type ReviewCommentSensitiveTextRedactionOptionsV1 = Readonly<{
    redactedValues?: readonly (string | null | undefined)[];
}>;

export type CreateReviewCommentFingerprintInputV1 = Readonly<{
    ruleId?: string | null;
    fileSha?: string | null;
    anchor?: ReviewCommentAnchorV1 | null;
    message: string;
    engineId?: string | null;
}>;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : undefined;
}

function normalizeFingerprintMessage(value: string): string {
    return redactReviewCommentSensitiveText(value)
        .replace(/\r\n?/g, '\n')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizeFingerprintAnchor(anchor: ReviewCommentAnchorV1 | null | undefined): unknown {
    if (!anchor) return undefined;
    switch (anchor.kind) {
        case 'line':
            return {
                kind: 'line',
                filePath: anchor.filePath.trim(),
                line: anchor.line,
                ...(anchor.side ? { side: anchor.side } : {}),
            };
        case 'range':
            return {
                kind: 'range',
                filePath: anchor.filePath.trim(),
                startLine: anchor.startLine,
                endLine: anchor.endLine,
                ...(anchor.side ? { side: anchor.side } : {}),
            };
        case 'hunk':
            return {
                kind: 'hunk',
                filePath: anchor.filePath.trim(),
                hunkId: anchor.hunkId.trim(),
                ...(anchor.side ? { side: anchor.side } : {}),
            };
        case 'file':
            return {
                kind: 'file',
                filePath: anchor.filePath.trim(),
            };
        case 'folder':
            return {
                kind: 'folder',
                folderPath: anchor.folderPath.trim(),
            };
        case 'workspace':
            return {
                kind: 'workspace',
                workspaceId: anchor.workspaceId.trim(),
            };
        case 'project':
            return {
                kind: 'project',
                projectId: anchor.projectId.trim(),
            };
        case 'run':
            return {
                kind: 'run',
                runId: anchor.runId.trim(),
            };
        case 'finding':
            return {
                kind: 'finding',
                runId: anchor.runId.trim(),
                findingId: anchor.findingId.trim(),
            };
        case 'binary':
            return {
                kind: 'binary',
                filePath: anchor.filePath.trim(),
                sizeBytes: anchor.sizeBytes,
                sha256: anchor.sha256.trim(),
            };
        case 'submodule': {
            const commitSha = normalizeOptionalText(anchor.commitSha);
            const url = normalizeOptionalText(anchor.url);
            return {
                kind: 'submodule',
                filePath: anchor.filePath.trim(),
                ...(commitSha ? { commitSha } : {}),
                ...(url ? { url } : {}),
            };
        }
        case 'symlink':
            return {
                kind: 'symlink',
                filePath: anchor.filePath.trim(),
                targetPath: anchor.targetPath.trim(),
            };
    }
}

function lineRangeFromAnchor(
    anchor: ReviewCommentAnchorV1 | null | undefined,
): ReviewCommentFingerprintV1['lineRange'] | undefined {
    if (!anchor) return undefined;
    if (anchor.kind === 'line') {
        return { startLine: anchor.line, endLine: anchor.line };
    }
    if (anchor.kind === 'range') {
        return { startLine: anchor.startLine, endLine: anchor.endLine };
    }
    return undefined;
}

export function redactReviewCommentSensitiveText(
    input: string,
    options: ReviewCommentSensitiveTextRedactionOptionsV1 = {},
): string {
    let out = redactBugReportSensitiveText(String(input ?? ''));
    for (const raw of options.redactedValues ?? []) {
        const secret = String(raw ?? '').trim();
        if (!secret) continue;
        out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    }
    return out
        .replace(/\b([A-Z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*=\s*([^\s,;]+)/gi, '$1=[REDACTED]')
        .replace(/(^|[\s,;])(--(?:api-?key|secret|token|password|credential|auth)(?:=|\s+))([^\s,;]+)/gi, '$1$2[REDACTED]');
}

export function createReviewCommentFingerprintV1(
    input: CreateReviewCommentFingerprintInputV1,
): ReviewCommentFingerprintV1 {
    const ruleId = normalizeOptionalText(input.ruleId);
    const fileSha = normalizeOptionalText(input.fileSha);
    const engineId = normalizeOptionalText(input.engineId);
    const anchor = normalizeFingerprintAnchor(input.anchor);
    const lineRange = lineRangeFromAnchor(input.anchor);
    const payload = {
        v: 1,
        ...(ruleId ? { ruleId: ruleId.toLowerCase() } : {}),
        ...(anchor ? { anchor } : {}),
        message: normalizeFingerprintMessage(input.message),
    };
    return {
        ...(ruleId ? { ruleId } : {}),
        ...(fileSha ? { fileSha } : {}),
        ...(lineRange ? { lineRange } : {}),
        normalizedMessageHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        ...(engineId ? { engineId } : {}),
    };
}

export type {
    ReviewCommentAnchorV1,
    ReviewCommentEvidenceV1,
    ReviewCommentFingerprintV1,
    ReviewCommentSnapshotV1,
    ReviewCommentV1,
};
