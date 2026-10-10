import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';

import {
    buildAttachmentMessageMeta,
    formatAttachmentsBlock,
} from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { mergeMessageMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import { buildComposerSnapshotStructuredInputMetaOverrides } from '@/components/sessions/composer/composerScopeAdapters';
import { resolveReviewCommentDraftAnchorsForPrompt } from '@/components/sessions/reviews/comments/resolveReviewCommentDraftAnchorsForPrompt';
import { buildReviewCommentsOutboundMessage } from '@/sync/domains/input/reviewComments/buildReviewCommentsOutboundMessage';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { readNewSessionDraftFromRepository, writeTemporaryComputerActivationRefToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { clearCapturedNewSessionDraftAfterLaunch } from '@/components/sessions/new/modules/newSessionDraftLifecycle';
import {
    readAcceptedRunnerCreatorActivationBinding,
    readPreparedRunnerCreatorLaunchCustody,
    readRunnerCreatorAttachmentUploadCustody,
    recordRunnerCreatorAttachmentUploadCheckpoint,
} from '@/sync/domains/ephemeralRunner/runnerCreatorLaunchCustody';
import { removeRunnerCreatorCustodyForActivation } from '@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval';
import {
    uploadReviewedRunnerAttachments,
    type ReviewedRunnerAttachmentUpload,
} from '@/sync/domains/ephemeralRunner/uploadReviewedRunnerAttachments';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { storage } from '@/sync/domains/state/storage';
import { buildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { followUpSpawnedSessionWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { persistCreatedSessionAuthoringOrigin } from '@/components/sessions/new/modules/newSessionAuthoringOrigin';
import { sync } from '@/sync/sync';

export function buildTemporaryComputerFirstPrompt(input: Readonly<{
    reviewedText: string;
    uploaded: readonly ReviewedRunnerAttachmentUpload[];
}>): string {
    if (input.uploaded.length === 0) return input.reviewedText;
    const attachmentsBlock = formatAttachmentsBlock(input.uploaded);
    return input.reviewedText.trim().length > 0
        ? `${input.reviewedText}\n\n${attachmentsBlock}`
        : attachmentsBlock;
}

export function buildTemporaryComputerFirstPromptDelivery(input: Readonly<{
    composer: Parameters<typeof buildComposerSnapshotStructuredInputMetaOverrides>[0];
    uploaded: readonly ReviewedRunnerAttachmentUpload[];
    sessionId?: string;
    reviewComments?: readonly ReviewCommentDraft[];
}>): Readonly<{
    initialMessageText: string;
    displayText: string;
    metaOverrides: Record<string, unknown> | undefined;
}> {
    const structuredInputMeta = buildComposerSnapshotStructuredInputMetaOverrides(input.composer);
    const attachmentText = input.uploaded.length > 0 ? formatAttachmentsBlock(input.uploaded) : '';
    const baseMetaOverrides = mergeMessageMetaOverrides(
        input.uploaded.length > 0 ? buildAttachmentMessageMeta(input.uploaded) : undefined,
        Object.keys(structuredInputMeta).length > 0 ? structuredInputMeta : undefined,
    );
    if ((input.reviewComments?.length ?? 0) > 0) {
        if (!input.sessionId) throw new Error('runner_review_comments_session_unavailable');
        const outbound = buildReviewCommentsOutboundMessage({
            sessionId: input.sessionId,
            drafts: input.reviewComments ?? [],
            additionalMessage: buildTemporaryComputerFirstPrompt({
                reviewedText: input.composer.text,
                uploaded: input.uploaded,
            }),
            displayTextSuffix: attachmentText || null,
            metaOverrides: baseMetaOverrides,
        });
        return {
            initialMessageText: outbound.text,
            displayText: outbound.displayText,
            metaOverrides: outbound.metaOverrides,
        };
    }
    return {
        initialMessageText: buildTemporaryComputerFirstPrompt({
            reviewedText: input.composer.text,
            uploaded: input.uploaded,
        }),
        displayText: input.composer.text,
        metaOverrides: baseMetaOverrides,
    };
}

function deleteFrozenRunnerReviewComments(input: Readonly<{
    workspace: WorkspaceScopeBase;
    comments: readonly ReviewCommentDraft[];
}> | null | undefined): void {
    if (!input) return;
    const workspaceCacheKey = buildWorkspaceCacheKey(input.workspace);
    for (const comment of input.comments) {
        storage.getState().deleteWorkspaceReviewCommentDraft(workspaceCacheKey, comment.id);
    }
}

/**
 * One creator-side settlement sequence for an already-materialized Temporary
 * computer Session. The activation owner supplies the exact Session identity;
 * this owner checkpoints only effects completed during the current mount.
 * After a remount, replay remains safe through the canonical presentation,
 * message-local-id, and draft-currentness owners rather than another ledger.
 */
export function createMaterializedTemporaryComputerSettlement<TUploaded>(input: Readonly<{
    present: () => Promise<void>;
    upload: () => Promise<readonly TUploaded[]>;
    complete: (uploaded: readonly TUploaded[]) => Promise<void>;
    cleanup: () => Promise<void>;
}>): Readonly<{ run: () => Promise<void> }> {
    let presented = false;
    let uploaded: readonly TUploaded[] | null = null;
    let completed = false;
    let cleaned = false;
    let runInFlight: Promise<void> | null = null;

    const run = (): Promise<void> => {
        if (runInFlight) return runInFlight;
        const currentRun = (async () => {
            if (!presented) {
                await input.present();
                presented = true;
            }
            if (uploaded === null) {
                uploaded = await input.upload();
            }
            if (!completed) {
                await input.complete(uploaded);
                completed = true;
            }
            if (!cleaned) {
                await input.cleanup();
                cleaned = true;
            }
        })();
        runInFlight = currentRun;
        void currentRun.finally(() => {
            if (runInFlight === currentRun) runInFlight = null;
        }).catch(() => undefined);
        return currentRun;
    };

    return { run };
}

/**
 * Crosses from the creator overlay into the ordinary Session as soon as its
 * authoritative identity exists. Creator-local recovery remains retryable in
 * that Session and therefore cannot turn successful creation back into an
 * overlay-blocking failure.
 */
export async function presentMaterializedTemporaryComputerSessionAndContinueSettlement(input: Readonly<{
    present: () => Promise<void>;
    settle: () => Promise<void>;
}>): Promise<void> {
    await input.present();
    void input.settle().catch(() => undefined);
}

export type MaterializedTemporaryComputerRecoveryCandidate = Readonly<{
    draftId: string;
    activationId: string;
    launchUserAttemptId: string | null;
}>;

export type MaterializedTemporaryComputerSettlementInput = Readonly<{
    scope: ServerAccountScope;
    draftScope?: ServerAccountScope;
    draftId: string;
    activationId: string;
    launchUserAttemptId: string | null;
    sessionId: string;
    projection: RunnerActivationProjectionV1;
    present?: () => Promise<void>;
    complete?: (uploaded: readonly ReviewedRunnerAttachmentUpload[]) => Promise<void>;
    beforeCleanup?: () => Promise<void>;
    /** Genuine ordinary attachment-transfer boundary for owner-level tests. */
    uploadFile?: Parameters<typeof uploadReviewedRunnerAttachments>[0]['uploadFile'];
}>;

const materializedSettlementInFlight = new Map<string, Promise<void>>();

function settlementKey(input: Readonly<{
    scope: ServerAccountScope;
    activationId: string;
    sessionId: string;
}>): string {
    return `${serverAccountScopeKeySuffix(input.scope)}\u0000${input.activationId}\u0000${input.sessionId}`;
}

/**
 * One process-local singleflight shared by the creator overlay and the ordinary
 * Session shell. Durable retry identity remains in the incumbent launch custody;
 * this map is only overlap suppression and is deliberately cleared after failure.
 */
export function runMaterializedTemporaryComputerSessionSettlementSingleflight(
    input: Readonly<{ scope: ServerAccountScope; activationId: string; sessionId: string }>,
    settle: () => Promise<void>,
): Promise<void> {
    const key = settlementKey(input);
    const existing = materializedSettlementInFlight.get(key);
    if (existing) return existing;
    const pending = settle();
    materializedSettlementInFlight.set(key, pending);
    void pending.finally(() => {
        if (materializedSettlementInFlight.get(key) === pending) materializedSettlementInFlight.delete(key);
    }).catch(() => undefined);
    return pending;
}

async function clearExactTemporaryComputerActivationReference(input: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    activationId: string;
}>): Promise<void> {
    const current = readNewSessionDraftFromRepository({ scope: input.scope, draftId: input.draftId });
    if (current?.temporaryComputerActivationRef?.activationId !== input.activationId) return;
    writeTemporaryComputerActivationRefToRepository({
        scope: input.scope,
        draftId: input.draftId,
        activationRef: null,
    });
}

export async function completePersistedMaterializedTemporaryComputerCleanup(input: Readonly<{
    scope: ServerAccountScope;
    draftScope?: ServerAccountScope;
    draftId: string;
    activationId: string;
    launchUserAttemptId: string | null;
}>): Promise<void> {
    const draftScope = input.draftScope ?? input.scope;
    await clearCapturedNewSessionDraftAfterLaunch({
        scope: draftScope,
        draftId: input.draftId,
        launchUserAttemptId: input.launchUserAttemptId,
    });
    // These cleanup effects run only after digest verification and prompt
    // admission. The canonical custody owner removes staged bytes before their
    // private locator and key; only then may the synchronized recovery pointer
    // disappear. Failure therefore stays visible and retryable.
    await removeRunnerCreatorCustodyForActivation(input.scope, input.activationId);
    await clearExactTemporaryComputerActivationReference({
        scope: draftScope,
        draftId: input.draftId,
        activationId: input.activationId,
    });
}

/**
 * Crash/remount-safe completion for one already materialized Temporary computer
 * Session. It reopens creator-staged bytes, uploads through the ordinary Session
 * attachment owner, verifies the reviewed digest/size, then admits the first turn
 * with its persisted local id. Custody is removed only after all effects succeed.
 */
export async function settlePersistedMaterializedTemporaryComputerSession(
    input: MaterializedTemporaryComputerSettlementInput,
): Promise<void> {
    await runMaterializedTemporaryComputerSessionSettlementSingleflight(input, async () => {
        if (input.projection.state !== 'materialized'
            || input.projection.materialization?.sessionId !== input.sessionId) {
            throw new Error('runner_activation_binding_mismatch');
        }
        // Hot Send owns its completion. A cold authoring or Session-shell
        // recovery must retain provenance before retiring the persisted draft.
        const reopenedAuthoringOrigin = input.complete ? undefined : readNewSessionDraftFromRepository({
            scope: input.draftScope ?? input.scope,
            draftId: input.draftId,
        })?.authoringOrigin;
        const authoringOriginAccountLifetime = reopenedAuthoringOrigin ? captureActiveServerAccountScopeLifetime() : null;
        // The Session identity is already authoritative. Present it before any
        // creator-local custody, anchor recovery, upload, or prompt follow-up.
        await (input.present ?? (async () => undefined))();
        const binding = await readAcceptedRunnerCreatorActivationBinding(
            input.scope,
            input.activationId,
            input.projection,
        );
        if (binding.sessionId !== input.sessionId) throw new Error('runner_activation_binding_mismatch');

        const [preparedAuthoring, attachmentUpload] = await Promise.all([
            readPreparedRunnerCreatorLaunchCustody(input.scope, input.activationId),
            readRunnerCreatorAttachmentUploadCustody(input.scope, input.activationId),
        ]);
        const frozenReviewComments = preparedAuthoring.reviewComments;
        const resolvedFrozenReviewComments = frozenReviewComments
            ? await resolveReviewCommentDraftAnchorsForPrompt({
                drafts: frozenReviewComments.comments,
                reviewScope: frozenReviewComments.workspace,
            })
            : [];
        let promptAdmitted = false;
        const admitInitialPrompt = async (uploaded: readonly ReviewedRunnerAttachmentUpload[]): Promise<void> => {
            if (promptAdmitted) return;
            if (input.complete) {
                await input.complete(uploaded);
            } else {
                const delivery = buildTemporaryComputerFirstPromptDelivery({
                    composer: preparedAuthoring.composer,
                    uploaded,
                    sessionId: input.sessionId,
                    reviewComments: resolvedFrozenReviewComments,
                });
                await followUpSpawnedSessionWithServerScope({
                    sessionId: input.sessionId,
                    targetServerId: input.scope.serverId,
                    initialMessageText: delivery.initialMessageText,
                    displayText: delivery.displayText,
                    metaOverrides: delivery.metaOverrides,
                    messageLocalId: attachmentUpload.firstTurnLocalId,
                });
                if (reopenedAuthoringOrigin) {
                    await persistCreatedSessionAuthoringOrigin({
                        sessionId: input.sessionId,
                        serverId: input.scope.serverId,
                        origin: reopenedAuthoringOrigin,
                        shouldContinue: () => authoringOriginAccountLifetime?.isCurrent() === true,
                        updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
                    });
                }
            }
            promptAdmitted = true;
        };

        const settlement = createMaterializedTemporaryComputerSettlement({
            present: async () => undefined,
            upload: () => uploadReviewedRunnerAttachments({
                sessionId: input.sessionId,
                sessionTarget: { ...input.scope, sessionId: input.sessionId },
                messageLocalId: attachmentUpload.attachmentMessageLocalId,
                reviewedFiles: preparedAuthoring.files,
                stagedFiles: attachmentUpload.stagedFiles,
                ...(attachmentUpload.resumedUploads ? { resumedUploads: attachmentUpload.resumedUploads } : {}),
                // Each verified file is checkpointed in the incumbent activation
                // custody, so a partial-batch retry reuses the remote path the
                // Session already has instead of uploading the bytes twice.
                onVerifiedUpload: (upload) => recordRunnerCreatorAttachmentUploadCheckpoint({
                    scope: input.scope,
                    activationId: input.activationId,
                    upload,
                }),
                destination: preparedAuthoring.attachmentDestination,
                maxFileBytes: attachmentUpload.maxFileBytes,
                ...(input.uploadFile ? { uploadFile: input.uploadFile } : {}),
                admitInitialPrompt,
            }),
            complete: admitInitialPrompt,
            cleanup: async () => {
                await input.beforeCleanup?.();
                deleteFrozenRunnerReviewComments(frozenReviewComments);
                await completePersistedMaterializedTemporaryComputerCleanup(input);
            },
        });
        await settlement.run();
    });
}

/** Local accepted binding correlates the Session; the exact activation read proves current materialization. */
export async function recoverMaterializedTemporaryComputerSessionForSession(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    candidates: readonly MaterializedTemporaryComputerRecoveryCandidate[];
    /** Test seam over the incumbent creator-local binding owner. */
    readAcceptedBinding?: (activationId: string) => Promise<Readonly<{ sessionId: string }>>;
    readActivation: (activationId: string) => Promise<RunnerActivationProjectionV1>;
    settle?: (input: MaterializedTemporaryComputerSettlementInput) => Promise<void>;
}>): Promise<'settled' | 'not_found' | 'retryable_unavailable'> {
    for (const candidate of input.candidates) {
        let acceptedBinding: Readonly<{ sessionId: string }>;
        try {
            acceptedBinding = await (input.readAcceptedBinding
                ? input.readAcceptedBinding(candidate.activationId)
                : readAcceptedRunnerCreatorActivationBinding(input.scope, candidate.activationId));
        } catch {
            // A synchronized draft reference can be inspected on another device,
            // but only the creating device's accepted binding can prove that its
            // local staged custody belongs to this exact Session.
            continue;
        }
        if (acceptedBinding.sessionId !== input.sessionId) continue;

        let projection: RunnerActivationProjectionV1;
        try {
            projection = await input.readActivation(candidate.activationId);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return 'not_found';
            if (error instanceof RunnerActivationClientError && error.code === 'not_found') return 'not_found';
            // The local accepted binding already correlates this candidate with
            // the open Session. Preserve its staged bytes and expose the existing
            // ordinary-Session retry surface instead of silently waiting for a
            // socket reconnect that may never occur.
            return 'retryable_unavailable';
        }
        if (projection.activationId !== candidate.activationId
            || projection.state !== 'materialized'
            || projection.materialization?.sessionId !== input.sessionId) continue;
        await (input.settle ?? settlePersistedMaterializedTemporaryComputerSession)({
            scope: input.scope,
            sessionId: input.sessionId,
            draftId: candidate.draftId,
            activationId: candidate.activationId,
            launchUserAttemptId: candidate.launchUserAttemptId,
            projection,
        });
        return 'settled';
    }
    return 'not_found';
}
