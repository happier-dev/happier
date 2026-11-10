import type { PluginUiHostApi, PluginUiSessionPlacementCandidateV1 } from '@happier-dev/plugin-sdk/ui';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { hasTriageActionInstructionSourceV1, readTriageActionLaunchModeV1, type TriageActionV1 } from '../settings/actions.js';
import { planTriageActionDeliveryV1 } from './actionDelivery.js';
import type { TriageActionCheckoutResolutionV1, TriageActionExecutionPlacementV1 } from './actionLaunch.js';
import type { TriageEntrySessionStartRequestV1 } from './entrySessionStartController.js';
import { projectTriagePreparedWorkspaceSelectionInputV1 } from '../ui/header/newSessionDestination.js';
import { projectTriageNewSessionFailureV1, requestTriageNewSessionSeed, type TriageNewSessionSeedV1, type TriageNewSessionSeedHostV1, type TriageNewSessionSeedResultV1 } from '../ui/header/newSessionSeedCommand.js';
import type { TriageEntryAttachmentDraftV1 } from '../composer/mutationPlan.js';

/**
 * The draft's "save as this action's default" configurator, or nothing for an action with no fixed prompt (Ask):
 * that question is typed each time, so there is no prompt to save and it cannot start without one.
 */
export function triageActionDefaultSeedV1(action: TriageActionV1): TriageNewSessionSeedV1['actionDefault'] {
    if (!hasTriageActionInstructionSourceV1(action.target)) return undefined;
    return { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, configuredActionId: action.actionId,
        label: action.label, launchMode: readTriageActionLaunchModeV1(action) };
}

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
        actionDefault?: TriageNewSessionSeedV1['actionDefault'];
        attachments?: readonly TriageEntryAttachmentDraftV1[];
        promptText: string | null;
        profileId: string | null;
        agentTarget?: NonNullable<Parameters<typeof requestTriageNewSessionSeed>[1]['agentTarget']>;
        checkoutIntent: TriageActionCheckoutResolutionV1;
        placement: TriageActionExecutionPlacementV1 | null;
        candidates: readonly PluginUiSessionPlacementCandidateV1[];
        signal?: AbortSignal;
        /** Correlates this bulk press with its prepared workspace operation. */
        requestId?: string;
        onRequest?: (requestId: string | null) => void;
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
        const directoryIntent = input.directoryIntent
            ?? (input.checkoutIntent === 'preparedReviewWorkspace' ? undefined : placement?.directoryIntent);
        if (input.requestId !== undefined) input.onRequest?.(input.requestId);
        return await requestTriageNewSessionSeed(host, {
            ...(delivery.kind === 'compose' && delivery.text !== undefined ? { prompt: delivery.text } : {}),
            ...(input.actionDefault === undefined ? {} : { actionDefault: input.actionDefault }),
            ...(input.profileId === null ? {} : { profileId: input.profileId }),
            ...(input.agentTarget === undefined ? {} : { agentTarget: input.agentTarget }),
            checkoutIntent: input.checkoutIntent,
            ...(directoryIntent === undefined ? {} : { directoryIntent }),
            ...(placement === null ? {} : { placement: {
                kind: 'exactTarget',
                serverId: placement.executionTarget.serverId,
                machineId: placement.executionTarget.machineId,
                ...(input.checkoutIntent === 'preparedReviewWorkspace' || placement.directory === undefined
                    ? {} : { directory: placement.directory }),
            } }),
            ...(input.candidates.length === 0 ? {} : { candidates: [...input.candidates] }),
            ...(delivery.kind === 'compose' && delivery.attachments.length > 0 ? { attachments: delivery.attachments } : {}),
        }, { ...preparation, signal: input.signal, ...(input.requestId === undefined ? {} : { requestId: input.requestId }) })
            .finally(() => input.onRequest?.(null));
    } catch (error) {
        if (input.signal?.aborted || input.isCurrent?.() === false) return { status: 'cancelled' };
        return { status: 'unavailable', failure: projectTriageNewSessionFailureV1(error) };
    }
}
