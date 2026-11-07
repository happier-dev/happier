import type { PluginUiHostApi, PluginUiSessionPlacementCandidateV1 } from '@happier-dev/plugin-sdk/ui';
import { planTriageActionDeliveryV1 } from './actionDelivery.js';
import type { TriageActionCheckoutResolutionV1, TriageActionExecutionPlacementV1 } from './actionLaunch.js';
import type { TriageEntrySessionStartRequestV1 } from './entrySessionStartController.js';
import { projectTriagePreparedWorkspaceSelectionInputV1 } from '../ui/header/newSessionDestination.js';
import { projectTriageNewSessionFailureV1, requestTriageNewSessionSeed, type TriageNewSessionSeedHostV1, type TriageNewSessionSeedResultV1 } from '../ui/header/newSessionSeedCommand.js';
import type { TriageEntryAttachmentDraftV1 } from '../composer/mutationPlan.js';

type AuthoringEntry = Pick<TriageEntrySessionStartRequestV1, 'entryRef' | 'sourceInstance' | 'presentation' | 'lastKnownLocator' | 'reviewWorkspace'>;

/** A prepared PR checkout has one source revision and one working directory. */
export function canShareTriageNewSessionCheckoutV1(checkout: TriageActionCheckoutResolutionV1, entryCount: number): boolean {
    return checkout !== 'preparedReviewWorkspace' || entryCount === 1;
}

/** Single and bulk compose share the same preparation, seed and host handoff. */
export async function requestTriageNewSessionAuthoringV1(
    host: TriageNewSessionSeedHostV1 & Pick<PluginUiHostApi, 'selectActionInput'>,
    input: Readonly<{
        entries: readonly AuthoringEntry[];
        attachments?: readonly TriageEntryAttachmentDraftV1[];
        promptText: string | null;
        profileId: string | null;
        agentTarget?: NonNullable<Parameters<typeof requestTriageNewSessionSeed>[1]['agentTarget']>;
        checkoutIntent: TriageActionCheckoutResolutionV1;
        placement: TriageActionExecutionPlacementV1 | null;
        candidates: readonly PluginUiSessionPlacementCandidateV1[];
        signal?: AbortSignal;
        /** The single-entry controller's existing mount-currentness owner. */
        isCurrent?: () => boolean;
        directoryIntent?: Parameters<typeof requestTriageNewSessionSeed>[1]['directoryIntent'];
    }>,
): Promise<TriageNewSessionSeedResultV1 | Readonly<{ status: 'refused'; reason: 'preparedWorkspaceUnsupported' | 'sharedPlacementIncompatible' }>> {
    try {
        const delivery = planTriageActionDeliveryV1({ delivery: 'compose', promptText: input.promptText, entries: input.entries, attachments: input.attachments });
        let placement = input.placement;
        let preparation: Parameters<typeof requestTriageNewSessionSeed>[2];
        if (input.checkoutIntent === 'preparedReviewWorkspace') {
            if (!canShareTriageNewSessionCheckoutV1(input.checkoutIntent, input.entries.length)) return { status: 'refused', reason: 'sharedPlacementIncompatible' };
            const review = input.entries[0]?.reviewWorkspace;
            if (review === undefined) return { status: 'refused', reason: 'preparedWorkspaceUnsupported' };
            let draft = projectTriagePreparedWorkspaceSelectionInputV1({
                preparation: review.preparation, placement, candidates: input.candidates,
            });
            if (draft.workspace === undefined) {
                const chosen = await host.selectActionInput({
                    hostAction: { action: 'session.spawn_new', projection: 'sessionPlacement' },
                    candidates: [...input.candidates],
                }, { signal: input.signal });
                if (chosen.kind === 'cancelled' || input.signal?.aborted || input.isCurrent?.() === false) return { status: 'cancelled' };
                if (chosen.kind !== 'sessionPlacement') return { status: 'refused', reason: 'preparedWorkspaceUnsupported' };
                placement = { executionTarget: { serverId: chosen.candidate.serverId, machineId: chosen.candidate.machineId },
                    directory: chosen.candidate.rootPath };
                draft = projectTriagePreparedWorkspaceSelectionInputV1({ preparation: review.preparation, placement, candidates: input.candidates });
            }
            const selected = await host.selectActionInput({
                operation: review.operation,
                draft,
            }, { signal: input.signal });
            if (selected.kind === 'cancelled' || input.signal?.aborted || input.isCurrent?.() === false) return { status: 'cancelled' };
            if (selected.kind !== 'submitted') return { status: 'refused', reason: 'preparedWorkspaceUnsupported' };
            preparation = { preparedReviewWorkspace: { operation: review.operation, result: selected } };
        }
        if (input.signal?.aborted || input.isCurrent?.() === false) return { status: 'cancelled' };
        return await requestTriageNewSessionSeed(host, {
            ...(delivery.kind === 'compose' && delivery.text !== undefined ? { prompt: delivery.text } : {}),
            ...(input.profileId === null ? {} : { profileId: input.profileId }),
            ...(input.agentTarget === undefined ? {} : { agentTarget: input.agentTarget }),
            checkoutIntent: input.checkoutIntent,
            ...(input.directoryIntent === undefined ? {} : { directoryIntent: input.directoryIntent }),
            ...(placement === null ? {} : { placement: {
                kind: 'exactTarget',
                serverId: placement.executionTarget.serverId,
                machineId: placement.executionTarget.machineId,
                ...(input.checkoutIntent === 'preparedReviewWorkspace' || placement.directory === undefined
                    ? {} : { directory: placement.directory }),
            } }),
            ...(input.candidates.length === 0 ? {} : { candidates: [...input.candidates] }),
            ...(delivery.kind === 'compose' && delivery.attachments.length > 0 ? { attachments: delivery.attachments } : {}),
        }, { ...preparation, signal: input.signal });
    } catch (error) {
        if (input.signal?.aborted || input.isCurrent?.() === false) return { status: 'cancelled' };
        return { status: 'unavailable', failure: projectTriageNewSessionFailureV1(error) };
    }
}
