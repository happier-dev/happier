import {
    TriageStartEntrySessionSettledDraftV1Schema,
    type TriageStartEntrySessionInputV1,
} from '../../actions/entrySessionProtocol.js';
import type { TriageEntrySessionIntentV1 } from '../../sessions/entrySessionOrchestrator.js';
import type { TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';

/**
 * The one projection from the host's settled new-Session draft to the
 * destination the start Action carries.
 *
 * The default Ask/Fix path names no Agent. Triage cannot: an
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
     * `settings/agentSelectionChoices.ts#resolveTriageAgentSpawnSelection`'s
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
     * A pull-request Fix. The reachable wire cannot request the prepared review
     * workspace that intent requires, so nothing is opened for it.
     */
    | 'pullRequestFixUnsupported'
    /** The host settled something this start cannot be built from. */
    | 'draftUnusable';

export type TriageNewSessionDestinationV1 =
    | Readonly<{
        status: 'settled';
        destination: TriageStartEntrySessionInputV1['destination'];
    }>
    | Readonly<{ status: 'refused'; reason: TriageNewSessionDestinationRefusalV1 }>;

/**
 * Which materialization an intent asks the orchestrator for, and `null` when
 * the reachable wire cannot request one at all.
 *
 * These are the orchestrator's own admitted pairings
 * (`entrySessionOrchestrator.ts#rejectionFor`), restated as a request rather
 * than re-decided: Ask never materializes a workspace, and every Fix outside a
 * pull request runs in the project the reader chose.
 *
 * It is exported because the press consults it BEFORE opening the host's New
 * Session surface — a pull-request Fix must be refused up front rather than
 * after the reader has spent an Agent and a directory choice on it — and the
 * projection below consults the same function afterwards. One decision, two
 * readers; a second copy in the caller is how the two would drift.
 */
export function planTriageNewSessionMaterializationV1(
    intent: TriageEntrySessionIntentV1,
    workflowSubject: TriageSourceWorkflowSubjectV1,
): 'referenceOnly' | 'selectedProject' | null {
    if (intent === 'ask') return 'referenceOnly';
    return workflowSubject === 'pullRequest' ? null : 'selectedProject';
}

export function projectTriageNewSessionDestinationV1(input: Readonly<{
    intent: TriageEntrySessionIntentV1;
    workflowSubject: TriageSourceWorkflowSubjectV1;
    /** Minted once per logical start and re-sent unchanged on a retry. */
    creationKey: string;
    /** Exactly what the host settled, unread and unreshaped until here. */
    settlement: unknown;
}>): TriageNewSessionDestinationV1 {
    const kind = planTriageNewSessionMaterializationV1(input.intent, input.workflowSubject);
    if (kind === null) return { status: 'refused', reason: 'pullRequestFixUnsupported' };

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
            materialization: { kind, directory: draft.data.directory },
        },
    };
}
