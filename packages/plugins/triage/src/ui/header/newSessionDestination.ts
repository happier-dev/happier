import {
    TriageStartEntrySessionSettledDraftV1Schema,
    type TriageStartEntrySessionInputV1,
} from '../../actions/entrySessionProtocol.js';
import {
    TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1,
    type TriageWorkspaceModeV1,
} from '../../sessions/entrySessionWorkspace.js';

/**
 * The one projection from the host's settled new-Session draft to the
 * destination the start Action carries.
 *
 * The default path names no Agent. Triage cannot: an
 * `agentTarget.identity` is the host's own backend-target vocabulary, and a
 * plugin that reconstructed it would be guessing at a catalog it does not own.
 * So the reader is taken to the host's New Session surface — the same place
 * they pick an Agent for every other Session — and this module turns what they
 * settled there into the exact `destination` the wire already declares.
 *
 * It decides nothing else. It mints no key, opens nothing, dispatches nothing
 * and reads no state; the intent-and-subject gate, the creation, the link and
 * the open all stay in `sessions/entrySessionOrchestrator.ts`. The one refusal
 * it does own is the pull-request Fix, and only because refusing it here is the
 * difference between telling the reader up front and spending their Agent and
 * directory choice on a start the gate rejects afterwards.
 */

/**
 * The Triage-side preference that may pre-select the host's own fields.
 *
 * A preference is a SEED, never a bypass. The surface opens either way, because
 * a Session also needs an execution target and a working directory and a
 * mounted plugin surface can produce neither: `PluginUiHostApiSurfaceContextV1`
 * carries no `machineId` or `serverId` at all, so the host's own settlement is
 * the ONLY plugin-visible producer of `executionTarget`. A pinned Agent
 * therefore shortens the choice rather than removing it.
 */
export type TriageNewSessionPreferenceV1 = Readonly<{
    /**
     * The Agent Triage settings pin for this intent, in the host's own
     * vocabulary: the agent local id, which is
     * the configured action's Launch Profile, resolved against the host inventory's
     * resolved `agentTarget.identity.localId`. It is deliberately not the
     * stored `agentTargetKey`: turning one into the other is the host
     * inventory's job, and parsing that key here would be exactly the
     * backend-target grammar this plugin must not own.
     */
    agentId?: string;
    /** The working directory Triage settings pin for Ask and Fix, if any. */
    directory?: string;
}>;

/**
 * The seed the host's composer admits, or `null` when Triage has nothing to
 * say and the host should use its own defaults.
 *
 * The host parses this strictly (`apps/ui/sources/components/sessions/new/
 * serverStartDraftComposer.ts#readSeed`), so an unknown or blank member is
 * dropped here rather than sent and refused.
 */
export function triageNewSessionDraftSeedV1(
    preference: TriageNewSessionPreferenceV1,
): Readonly<Record<string, string>> | null {
    const agentId = preference.agentId?.trim();
    const directory = preference.directory?.trim();
    const seed = {
        ...(agentId ? { agentId } : {}),
        ...(directory ? { directory } : {}),
    };
    return Object.keys(seed).length === 0 ? null : Object.freeze(seed);
}

export type TriageNewSessionDestinationRefusalV1 =
    /**
     * The action declares `pull_request`. The reachable wire cannot request the
     * prepared review workspace that mode names
     * (`actions/entrySessionProtocol.ts`), so nothing is opened for it.
     */
    | 'preparedWorkspaceUnsupported'
    /** The host settled something this start cannot be built from. */
    | 'draftUnusable';

export type TriageNewSessionDestinationV1 =
    | Readonly<{
        status: 'settled';
        destination: TriageStartEntrySessionInputV1['destination'];
    }>
    | Readonly<{ status: 'refused'; reason: TriageNewSessionDestinationRefusalV1 }>;

/**
 * The materialization this wire will carry for a mode, or `null` when it cannot
 * carry one at all.
 *
 * The pairing itself is NOT restated here: it is read from the single table the
 * gate validates against
 * (`sessions/entrySessionWorkspace.ts#TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1`).
 * What this function adds is the one fact the table cannot know — that the
 * reachable Action wire admits only the two directory materializations, because
 * preparing the third needs a source-declared operation no shipped source binds
 * (`actions/entrySessionProtocol.ts`).
 *
 * It is exported because the press consults it BEFORE opening the host's New
 * Session surface — spending a reader's Agent and directory choice on a start
 * that is refused afterwards is worse than telling them first — and the
 * projection below consults the same function once the host has settled. One
 * reader for both, so the up-front refusal and the built request cannot drift.
 */
export function triageNewSessionWireMaterializationV1(
    workspaceMode: TriageWorkspaceModeV1,
): 'referenceOnly' | 'selectedProject' | null {
    const kind = TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1[workspaceMode];
    return kind === 'reviewWorkspace' ? null : kind;
}

export function projectTriageNewSessionDestinationV1(input: Readonly<{
    /** The pressed action's declared mode. It IS the request; nothing re-decides it. */
    workspaceMode: TriageWorkspaceModeV1;
    /** Minted once per logical start and re-sent unchanged on a retry. */
    creationKey: string;
    /** Exactly what the host settled, unread and unreshaped until here. */
    settlement: unknown;
}>): TriageNewSessionDestinationV1 {
    const kind = triageNewSessionWireMaterializationV1(input.workspaceMode);
    if (kind === null) return { status: 'refused', reason: 'preparedWorkspaceUnsupported' };

    const draft = TriageStartEntrySessionSettledDraftV1Schema.safeParse(input.settlement);
    if (!draft.success) return { status: 'refused', reason: 'draftUnusable' };

    return {
        status: 'settled',
        destination: {
            kind: 'new',
            creationKey: input.creationKey,
            spawn: {
                executionTarget: draft.data.executionTarget,
                agentTarget: draft.data.agentTarget,
            },
            // The action's declared mode IS the materialization request, read
            // from the one table the gate validates it against. A second copy
            // of the pairings here is the unbound duplicate F1 named.
            materialization: { kind, directory: draft.data.directory },
        },
    };
}
