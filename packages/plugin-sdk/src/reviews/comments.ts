/** @moduleRealm daemon */
import { createHash } from 'node:crypto';

import type {
    ReviewCommentAnchorV1,
    ReviewCommentEvidenceV1,
    ReviewCommentFingerprintV1,
    ReviewCommentSnapshotV1,
    ReviewCommentV1,
} from '@happier-dev/protocol';

import { redactBugReportSensitiveText } from '../diagnostics.js';

export type ReviewCommentSensitiveTextRedactionOptions = Readonly<{
    redactedValues?: readonly (string | null | undefined)[];
}>;

export type CreateReviewCommentFingerprintInput = Readonly<{
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
    options: ReviewCommentSensitiveTextRedactionOptions = {},
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
    input: CreateReviewCommentFingerprintInput,
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

export type CreateReviewCommentFingerprintInputV1 = CreateReviewCommentFingerprintInput;
export type ReviewCommentSensitiveTextRedactionOptionsV1 = ReviewCommentSensitiveTextRedactionOptions;

export { createReviewCommentFingerprintV1 as createReviewCommentFingerprint };
