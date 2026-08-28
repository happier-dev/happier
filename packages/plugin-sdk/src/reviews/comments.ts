/** @moduleRealm any */
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import type {
    ReviewCommentAnchorV1,
    ReviewCommentEvidenceV1,
    ReviewCommentFingerprintV1,
    ReviewCommentLinkedIssueIdentityV1,
    ReviewCommentSnapshotV1,
    ReviewCommentV1,
    ReviewCommentClaimPublicationDispatchResponseV1,
    ReviewCommentPublicationCorrelationV1,
    ReviewCommentPublicationEntryV1,
    ReviewCommentPublicationEntryResultV1,
    ReviewCommentPublicationPlanV1,
    ReviewCommentPublicationResultV1,
    ReviewCommentPublicationRoutingV1,
    ReviewCommentPublicationTargetV1,
    ReviewCommentPublicationVerdictV1,
    ReviewCommentPublicationVerdictResultV1,
} from '@happier-dev/protocol';
import {
    createReviewCommentLinkedIssueIdV1,
    formatReviewCommentPublicationMarkerV1,
    matchReviewCommentPublicationMarkerV1,
    parseReviewCommentPublicationPlanV1,
    preflightReviewCommentPublicationRoutingV1,
    reviewCommentPublicationEntryIsDiffLessV1,
    reviewCommentPublicationTargetMatchesV1,
    validateReviewCommentPublicationClaimAgainstPlanV1,
    validateReviewCommentPublicationResultAgainstPlanV1,
} from '@happier-dev/protocol';

import { redactBugReportSensitiveText } from '../diagnostics.js';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '../protocol/index.js';

const nonEmptyPublicationString = defineProtocolString({ minLength: 1 });
const publicationBoolean = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);
const publicationAnchorSide = defineProtocolUnion([
    defineProtocolLiteral('before'),
    defineProtocolLiteral('after'),
]);
const publicationSnapshotSource = defineProtocolUnion([
    defineProtocolLiteral('workingTree'),
    defineProtocolLiteral('committed'),
    defineProtocolLiteral('diffSide'),
    defineProtocolLiteral('agentBuffer'),
    defineProtocolLiteral('untracked'),
]);
const publicationAnchor = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('line'),
        filePath: nonEmptyPublicationString,
        line: defineProtocolNumber({ integer: true, minimum: 1 }),
        side: publicationAnchorSide.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('range'),
        filePath: nonEmptyPublicationString,
        startLine: defineProtocolNumber({ integer: true, minimum: 1 }),
        endLine: defineProtocolNumber({ integer: true, minimum: 1 }),
        side: publicationAnchorSide.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('hunk'),
        filePath: nonEmptyPublicationString,
        hunkId: nonEmptyPublicationString,
        side: publicationAnchorSide.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('file'), filePath: nonEmptyPublicationString }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('folder'), folderPath: nonEmptyPublicationString }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('workspace'), workspaceId: nonEmptyPublicationString }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('project'), projectId: nonEmptyPublicationString }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('run'), runId: nonEmptyPublicationString }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('finding'),
        runId: nonEmptyPublicationString,
        findingId: nonEmptyPublicationString,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('binary'),
        filePath: nonEmptyPublicationString,
        sizeBytes: defineProtocolNumber({ integer: true, minimum: 0 }),
        sha256: nonEmptyPublicationString,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('submodule'),
        filePath: nonEmptyPublicationString,
        commitSha: nonEmptyPublicationString.optional(),
        url: nonEmptyPublicationString.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('symlink'),
        filePath: nonEmptyPublicationString,
        targetPath: nonEmptyPublicationString,
    }, { policy: 'closed' }),
]);
const publicationTextLines = defineProtocolArray(defineProtocolString());
const publicationSnapshot = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('text'),
        selectedLines: publicationTextLines,
        beforeContext: publicationTextLines,
        afterContext: publicationTextLines,
        selectedLinesHash: nonEmptyPublicationString,
        contextWindowHash: nonEmptyPublicationString,
        capturedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
        fileLength: defineProtocolNumber({ integer: true, minimum: 0 }),
        source: publicationSnapshotSource,
        commitSha: nonEmptyPublicationString.optional(),
        isUncommitted: publicationBoolean,
        isUntracked: publicationBoolean,
        truncated: publicationBoolean,
        truncationReason: defineProtocolUnion([
            defineProtocolLiteral('file_too_large'),
            defineProtocolLiteral('line_too_long'),
            defineProtocolLiteral('context_cap'),
        ]).optional(),
        hasBidiControls: publicationBoolean,
        likelyMinified: publicationBoolean,
        diffContext: defineProtocolObject({
            side: publicationAnchorSide,
            baseSha: nonEmptyPublicationString.optional(),
            headSha: nonEmptyPublicationString.optional(),
            startSha: nonEmptyPublicationString.optional(),
        }, { policy: 'closed' }).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('binary'),
        sizeBytes: defineProtocolNumber({ integer: true, minimum: 0 }),
        sha256: nonEmptyPublicationString,
        mimeType: nonEmptyPublicationString.optional(),
        source: publicationSnapshotSource,
        capturedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('submodule'),
        filePath: nonEmptyPublicationString,
        commitSha: nonEmptyPublicationString.optional(),
        url: nonEmptyPublicationString.optional(),
        capturedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('symlink'),
        filePath: nonEmptyPublicationString,
        targetPath: nonEmptyPublicationString,
        targetExists: publicationBoolean.optional(),
        capturedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('too_large'),
        filePath: nonEmptyPublicationString,
        sizeBytes: defineProtocolNumber({ integer: true, minimum: 0 }),
        sha256: nonEmptyPublicationString.optional(),
        capBytes: defineProtocolNumber({ integer: true, minimum: 1 }),
        capturedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
    }, { policy: 'closed' }),
]);
const publicationTarget = defineProtocolObject({
    providerId: nonEmptyPublicationString,
    configuredAccountId: nonEmptyPublicationString,
    entryRef: defineProtocolObject({
        sourceId: nonEmptyPublicationString,
        kindId: nonEmptyPublicationString,
        collisionScope: nonEmptyPublicationString,
        entryId: nonEmptyPublicationString,
    }, { policy: 'closed' }),
    subtarget: defineProtocolUnion([
        defineProtocolLiteral(null),
        defineProtocolObject({
            kindId: defineProtocolUnion([
                defineProtocolLiteral('review-thread'),
                defineProtocolLiteral('review-comment'),
            ]),
            targetId: nonEmptyPublicationString,
        }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });
const publicationEntry = defineProtocolObject({
    happierCommentId: nonEmptyPublicationString,
    expectedServerRevision: defineProtocolNumber({ integer: true, minimum: 1 }),
    anchor: publicationAnchor,
    snapshot: publicationSnapshot,
    body: nonEmptyPublicationString,
}, { policy: 'closed' });
const publicationVerdict = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('approve'),
        defineProtocolLiteral('requestChanges'),
        defineProtocolLiteral('comment'),
    ]),
    body: nonEmptyPublicationString,
}, { policy: 'closed' });
const publicationPlanTarget = {
    target: publicationTarget,
} as const;
const publicationUnversionedPlan = {
    ...publicationPlanTarget,
    baseRevision: defineProtocolLiteral(null),
    headRevision: defineProtocolLiteral(null),
} as const;

/**
 * Builds the shared PR-review plan around a provider's exact revision syntax.
 * Providers narrow only revision identity; Reviews remains the sole owner of
 * target, entry, verdict, and at-least-one-effect structure.
 */
export function defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema(
    revisionSchema: ProtocolComposableSchema<string, string>,
) {
    const revisionedPlan = {
        ...publicationPlanTarget,
        baseRevision: revisionSchema,
        headRevision: revisionSchema,
    } as const;
    return defineProtocolUnion([
        defineProtocolObject({
            ...revisionedPlan,
            entries: defineProtocolArray(publicationEntry, { minItems: 1 }),
            verdict: defineProtocolUnion([defineProtocolLiteral(null), publicationVerdict]),
        }, { policy: 'closed' }),
        defineProtocolObject({
            ...revisionedPlan,
            entries: defineProtocolArray(publicationEntry),
            verdict: publicationVerdict,
        }, { policy: 'closed' }),
    ]);
}

/** Exact one-comment/no-verdict PR publication for standalone comment Actions. */
export function defineReviewCommentRevisionedSingleEntryPublicationPlanV1ProtocolSchema(
    revisionSchema: ProtocolComposableSchema<string, string>,
) {
    return defineProtocolObject({
        ...publicationPlanTarget,
        baseRevision: revisionSchema,
        headRevision: revisionSchema,
        entries: defineProtocolArray(publicationEntry, { minItems: 1, maxItems: 1 }),
        verdict: defineProtocolLiteral(null),
    }, { policy: 'closed' });
}

/** Generic concrete-revision variant for hosts without a narrower SCM syntax. */
export const ReviewCommentRevisionedPublicationPlanV1ProtocolSchema =
    defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema(nonEmptyPublicationString);

/** Manifest-authoring projection for issue comments and replies without synthetic SCM revisions. */
export const ReviewCommentUnversionedPublicationPlanV1ProtocolSchema = defineProtocolObject({
    ...publicationUnversionedPlan,
    entries: defineProtocolArray(publicationEntry, { minItems: 1 }),
    verdict: defineProtocolLiteral(null),
}, { policy: 'closed' });

/** Exact one-comment/no-verdict publication for standalone issue/reply Actions. */
export const ReviewCommentUnversionedSingleEntryPublicationPlanV1ProtocolSchema = defineProtocolObject({
    ...publicationUnversionedPlan,
    entries: defineProtocolArray(publicationEntry, { minItems: 1, maxItems: 1 }),
    verdict: defineProtocolLiteral(null),
}, { policy: 'closed' });

/** Canonical union used by generic Reviews transport and storage owners. */
export const ReviewCommentPublicationPlanV1ProtocolSchema = defineProtocolUnion([
    ReviewCommentRevisionedPublicationPlanV1ProtocolSchema,
    ReviewCommentUnversionedPublicationPlanV1ProtocolSchema,
]);

const publicationCorrelationId = defineProtocolString({ pattern: '^[A-Za-z0-9_-]{43}$' });
const publicationOutcome = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('published'),
        externalRef: nonEmptyPublicationString,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'),
        code: nonEmptyPublicationString,
        message: nonEmptyPublicationString.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('uncertain') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('skippedPriorFailure') }, { policy: 'closed' }),
]);
const publicationVerdictOutcome = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('published'),
        externalRef: nonEmptyPublicationString.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'),
        code: nonEmptyPublicationString,
        message: nonEmptyPublicationString.optional(),
        externalRef: nonEmptyPublicationString.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('uncertain'),
        externalRef: nonEmptyPublicationString.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('skippedPriorFailure') }, { policy: 'closed' }),
]);

/** Canonical manifest-authoring projection for exact-cardinality publication outcomes. */
export const ReviewCommentPublicationResultV1ProtocolSchema = defineProtocolObject({
    publicationPlanId: publicationCorrelationId,
    entries: defineProtocolArray(defineProtocolObject({
        happierCommentId: nonEmptyPublicationString,
        publicationCorrelationId,
        outcome: publicationOutcome,
    }, { policy: 'closed' })),
    verdict: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('notRequested') }, { policy: 'closed' }),
        defineProtocolObject({
            publicationCorrelationId,
            outcome: publicationVerdictOutcome,
        }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });

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
        normalizedMessageHash: bytesToHex(sha256(utf8ToBytes(JSON.stringify(payload)))),
        ...(engineId ? { engineId } : {}),
    };
}

export type {
    ReviewCommentAnchorV1,
    ReviewCommentEvidenceV1,
    ReviewCommentFingerprintV1,
    ReviewCommentLinkedIssueIdentityV1,
    ReviewCommentSnapshotV1,
    ReviewCommentV1,
    ReviewCommentClaimPublicationDispatchResponseV1,
    ReviewCommentPublicationCorrelationV1,
    ReviewCommentPublicationEntryV1,
    ReviewCommentPublicationEntryResultV1,
    ReviewCommentPublicationPlanV1,
    ReviewCommentPublicationResultV1,
    ReviewCommentPublicationRoutingV1,
    ReviewCommentPublicationTargetV1,
    ReviewCommentPublicationVerdictV1,
    ReviewCommentPublicationVerdictResultV1,
};

export type CreateReviewCommentFingerprintInputV1 = CreateReviewCommentFingerprintInput;
export type ReviewCommentSensitiveTextRedactionOptionsV1 = ReviewCommentSensitiveTextRedactionOptions;

export { createReviewCommentFingerprintV1 as createReviewCommentFingerprint };
export { createReviewCommentLinkedIssueIdV1 };
export { validateReviewCommentPublicationClaimAgainstPlanV1 };
export { validateReviewCommentPublicationResultAgainstPlanV1 };
export { parseReviewCommentPublicationPlanV1 };
export { preflightReviewCommentPublicationRoutingV1 };
export { reviewCommentPublicationEntryIsDiffLessV1 };
export { formatReviewCommentPublicationMarkerV1 };
export { matchReviewCommentPublicationMarkerV1 };
export { reviewCommentPublicationTargetMatchesV1 };
