import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi, PluginUiSessionPlacementCandidateV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageActionExecutionPlacementV1 } from '../../sessions/actionLaunch.js';
import { selectTriageSessionPlacementV1 } from '../../sessions/newSessionAuthoring.js';
import { triageNewSessionDraftSeedV1, type TriageNewSessionDraftActionContextV1, type TriageNewSessionPreferenceV1 } from './newSessionDestination.js';
import { isHostCancellation } from '../../hostCancellation.js';
import { projectTriageNewSessionFailureV1, type TriageNewSessionFailureV1 } from './newSessionSeedCommand.js';

/**
 * The header's one path to the host's own New Session surface.
 *
 * A configured action starts a Session, and a Session needs an Agent. Triage cannot name
 * one: `agentTarget.identity` is the host's backend-target vocabulary, and a
 * plugin that reconstructed it would be inventing a catalog it does not own. So
 * the reader is taken to the surface that already owns that choice — the same
 * New Session fields they use for every other Session — through the one
 * no-invoke settlement a plugin may ask the host for
 * (`packages/protocol/src/plugins/ui/hostApiRequests.ts`, `serverStartDraft`).
 *
 * Nothing is created here. The settlement is a draft: the host opens its own
 * authoring surface, settles what the reader chose, and invokes nothing. The
 * creation, the link and the open all still happen in one place, behind this
 * plugin's own start Action.
 *
 * The host owns project and Agent choice. The draft carries the selected
 * placement after the shared project picker settles.
 */

/** The literal host selection this header is allowed to ask for, and no other. */
const NEW_SESSION_DRAFT_REQUEST = Object.freeze({
    action: 'session.spawn_new',
    projection: 'serverStartDraft',
} as const);

/**
 * What a draft request needs from a mount.
 *
 * `version()` is part of the capability rather than an afterthought: the list
 * page deliberately does not declare `selectActionInput` among its required
 * host methods, because requiring it would refuse the whole page — rows,
 * filters and all — on a host that cannot select an Action input. The press
 * asks instead, and reports its own typed refusal.
 */
export type TriageNewSessionDraftHostV1 = Pick<PluginUiHostApi, 'selectActionInput'> & Readonly<{
    version(): Readonly<{ methods: readonly string[] }>;
}>;

export type TriageNewSessionDraftResultV1 =
    /** The reader settled the host's New Session fields. Unread on purpose. */
    | Readonly<{ status: 'settled'; settlement: unknown }>
    /** The reader closed the surface. Nothing was chosen and nothing failed. */
    | Readonly<{ status: 'cancelled' }>
    /** This mount installs no Action-input selection at all. */
    | Readonly<{ status: 'unsupported' }>
    /** The surface could not be opened or did not answer in the host's shape. */
    | Readonly<{ status: 'unavailable'; failure?: TriageNewSessionFailureV1 }>;

export async function requestTriageNewSessionDraft(
    host: TriageNewSessionDraftHostV1,
    input: Readonly<{
        preference: TriageNewSessionPreferenceV1;
        placement?: TriageActionExecutionPlacementV1;
        actionContext?: TriageNewSessionDraftActionContextV1;
        candidates?: readonly PluginUiSessionPlacementCandidateV1[];
    }>,
    options?: PluginCancellationOptions,
): Promise<TriageNewSessionDraftResultV1> {
    let installed: readonly string[];
    try {
        installed = host.version().methods;
    } catch {
        return { status: 'unsupported' };
    }
    if (!installed.includes('selectActionInput')) return { status: 'unsupported' };

    try {
        let placement = input.placement;
        let preference = input.preference;
        // Offer the complete list through the host's typed project selector.
        // The draft carries only the resulting target and directory.
        if (input.candidates?.length && (placement === undefined || input.candidates.length > 1 || preference.directory?.trim())) {
            const chosen = await selectTriageSessionPlacementV1(host, input.candidates, options?.signal);
            if (options?.signal?.aborted || chosen.kind === 'cancelled') return { status: 'cancelled' };
            if (chosen.kind !== 'sessionPlacement') return { status: 'unavailable' };
            const { serverId, machineId, rootPath } = chosen.candidate;
            placement = { executionTarget: { serverId, machineId }, directory: rootPath };
            preference = preference.agentId === undefined ? {} : { agentId: preference.agentId };
        }
        const seed = triageNewSessionDraftSeedV1(preference, placement, input.actionContext);
        const selected = await host.selectActionInput({
            hostAction: NEW_SESSION_DRAFT_REQUEST,
            ...(seed ? { draft: seed } : {}),
        }, options);
        if (selected.kind === 'cancelled') return { status: 'cancelled' };
        if (selected.kind !== 'serverStartDraft') return { status: 'unavailable' };
        return { status: 'settled', settlement: selected.draft };
    } catch (error) {
        if (isHostCancellation(error, options?.signal)) return { status: 'cancelled' };
        return { status: 'unavailable', failure: projectTriageNewSessionFailureV1(error) };
    }
}
