import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiActionExecutionOptions, PluginUiHostApi, PluginUiSessionPlacementCandidateV1 } from '@happier-dev/plugin-sdk/ui';

import type {
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1,
} from '../../actions/entrySessionProtocol.js';
import { openLinkedSession } from '../../sessions/entrySessionOpen.js';
import type { TriageActionV1 } from '../../settings/actions.js';
import { projectTriageNewSessionDestinationV1 } from '../header/newSessionDestination.js';
import { authorizeTriagePreparedReviewWorkspaceV1 } from '../../sessions/entrySessionStartController.js';
import {
    submitTriageEntrySessionStart,
    type TriageSessionStartHostV1,
} from '../header/startEntrySessionCommand.js';
import type { TriageBulkSelectedEntryV1 } from './bulkSelectionEntries.js';
import {
    projectTriageBulkEntryOutcomesV1,
    type TriageBulkEntryOutcomeV1,
    type TriageBulkLinkOutcomeV1,
} from './bulkSessionOutcome.js';
import {
    runTriageBulkEntrySessions,
    type TriageBulkSessionDestinationV1,
    type TriageBulkSessionUnitResultV1,
    type TriageBulkSessionUnitV1,
} from './bulkSessionPlan.js';

/** The host boundary the completed bulk Session sequence consumes. */
export type TriageBulkSessionExecutionHostV1 = TriageSessionStartHostV1
    & Partial<Pick<PluginUiHostApi, 'selectActionInput'>>;

type TriageBulkStartedSessionOutcomeV1 = Readonly<{
    start: TriageStartEntrySessionResultV1;
    entries: readonly TriageBulkEntryOutcomeV1[];
}>;

type TriageBulkStartedSessionResultV1 = TriageBulkSessionUnitResultV1<
    TriageBulkStartedSessionOutcomeV1,
    TriageBulkSelectedEntryV1
>;

/**
 * Projects an already-answered start onto the incumbent phase-resume arm.
 *
 * This is custody, not a second retry owner: the Action result names the phase,
 * while the canonical start Action and orchestrator decide how that phase is
 * retried. Structured input is admitted only after the durable link. An
 * ambiguous admission therefore resumes from the existing Session with the
 * same public delivery identity; it never re-enters creation merely because a
 * later phase answered imprecisely.
 */
function readTriageBulkStartResumeV1(
    previous: TriageBulkStartedSessionResultV1 | undefined,
): TriageStartEntrySessionInputV1['resume'] {
    if (previous?.status !== 'settled') return undefined;
    const result = previous.outcome.start;
    if (result.type === 'creationPending') {
        return {
            phase: 'creationPending',
            ...(result.preparedReviewWorkspace === undefined
                ? {}
                : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
        };
    }
    if (result.type === 'linkPending' || result.type === 'openPending') {
        return {
            phase: result.type,
            sessionId: result.sessionId,
            disposition: result.disposition,
            // An unknown answer is intentionally omitted. The canonical phase
            // resume invokes the idempotent sender again; a settled answer is
            // carried so an open retry cannot send twice.
            ...(result.delivery === undefined || result.delivery === 'outcomeUnknown'
                ? {}
                : { delivery: result.delivery }),
            ...(result.preparedReviewWorkspace === undefined
                ? {}
                : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
        };
    }
    if (result.type === 'opened' && result.delivery === 'outcomeUnknown') {
        return {
            phase: 'openPending',
            sessionId: result.sessionId,
            disposition: result.disposition,
            ...(result.preparedReviewWorkspace === undefined
                ? {}
                : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
        };
    }
    if (result.type === 'linked' && result.delivery === 'outcomeUnknown') {
        // A suppressed per-entry start has no delivery-only wire arm. Reusing
        // the incumbent link resume is truthful and idempotent: it rejoins the
        // durable relationship, re-asks admission, and still respects the
        // batch-owned final-open policy instead of respawning the Session.
        return {
            phase: 'linkPending',
            sessionId: result.sessionId,
            disposition: result.disposition,
            ...(result.preparedReviewWorkspace === undefined
                ? {}
                : { preparedReviewWorkspace: result.preparedReviewWorkspace }),
        };
    }
    return undefined;
}

/**
 * Runs already-resolved bulk Session units in order.
 *
 * Creation, the complete attachment-derived link set, delivery and generic
 * open remain below the Triage start Action. This sequence supplies one unit
 * and retains only the batch's final-navigation policy.
 */
export async function runTriageBulkEntrySessionStartsV1(input: Readonly<{
    host: TriageBulkSessionExecutionHostV1;
    units: readonly TriageBulkSessionUnitV1<TriageBulkSelectedEntryV1>[];
    action: TriageActionV1;
    /** The planned destination decides who, if anyone, performs final navigation. */
    destination: TriageBulkSessionDestinationV1;
    promptText: string | null;
    settlement: unknown;
    /** Per-unit settled host choice for the independent-placement destination. */
    settlementForUnit?: (unit: TriageBulkSessionUnitV1<TriageBulkSelectedEntryV1>) => unknown;
    placementCandidatesForUnit?: (unit: TriageBulkSessionUnitV1<TriageBulkSelectedEntryV1>) => readonly PluginUiSessionPlacementCandidateV1[];
    onPreparationCancelled?: () => void;
    signal: AbortSignal;
    onStarted?: () => void;
    /** Prior same-key answers; used only to project the canonical resume arm. */
    previousResults?: readonly TriageBulkStartedSessionResultV1[];
}>): Promise<readonly TriageBulkStartedSessionResultV1[]> {
    // The seed destination never reaches this sequence: it is consumed by the
    // host New Session surface before a Triage Session exists.
    if (input.destination === 'attachAllToNewSession') {
        throw new Error('triage:bulk:seedDestinationCannotRun');
    }
    const promptText = input.promptText;
    if (promptText === null || promptText.trim().length === 0) {
        throw new Error('triage:bulk:instructionRequired');
    }
    const finalOpen = input.destination === 'oneSessionForAllEntries'
        ? 'deferred' as const
        : 'suppressed' as const;
    return await runTriageBulkEntrySessions<TriageBulkStartedSessionOutcomeV1, TriageBulkSelectedEntryV1>({
        units: input.units,
        signal: input.signal,
        start: async (unit) => {
            const first = unit.entries[0];
            if (first === undefined) throw new Error('triage:bulk:emptyUnit');
            const settlement = input.settlementForUnit === undefined
                ? input.settlement
                : input.settlementForUnit(unit);
            const destination = projectTriageNewSessionDestinationV1({
                workspaceMode: input.action.workspaceMode,
                creationKey: unit.creationKey,
                settlement,
                ...(input.action.profileId === null ? {} : { profileId: input.action.profileId }),
                ...(first.reviewWorkspace === undefined ? {} : { reviewWorkspace: first.reviewWorkspace.preparation }),
                placementCandidates: input.placementCandidatesForUnit?.(unit) ?? [],
            });
            if (destination.status === 'refused') throw new Error('triage:bulk:destinationRefused');
            const previous = input.previousResults?.find(
                (candidate) => candidate.unit.creationKey === unit.creationKey,
            );
            const resume = readTriageBulkStartResumeV1(previous);
            let preparationSelection: TriageStartEntrySessionInputV1['prepareReviewWorkspaceSelection'];
            let startOptions: PluginUiActionExecutionOptions = { signal: input.signal };
            if (resume === undefined && destination.destination.kind === 'new'
                && destination.destination.materialization.kind === 'reviewWorkspace') {
                // A lost outer response needs a fresh single-use authorization,
                // not a replay of the carrier consumed by the original dispatch.
                const authorize = input.host.selectActionInput;
                const authorization = first.reviewWorkspace === undefined || authorize === undefined
                    ? { status: 'unavailable' as const }
                    : await authorizeTriagePreparedReviewWorkspaceV1(
                        { selectActionInput: authorize.bind(input.host) },
                        first.reviewWorkspace.operation,
                        destination.destination.materialization.request,
                        { signal: input.signal },
                    ).catch(() => ({ status: 'unavailable' as const }));
                if (authorization.status !== 'authorized') {
                    if (authorization.status === 'cancelled') input.onPreparationCancelled?.();
                    const start = { v: 1, type: 'workspacePreparationFailed', reason: 'failed', retryable: true } as const;
                    return { start, entries: projectTriageBulkEntryOutcomesV1({
                        entries: unit.entries, start, secondaryLinks: [], compose: 'notRequested',
                    }) };
                }
                preparationSelection = authorization.selection;
                startOptions = { ...authorization.options, signal: input.signal };
            }
            const result = await submitTriageEntrySessionStart(input.host, {
                v: 1,
                workspaceMode: input.action.workspaceMode,
                entryRef: first.entryRef,
                display: first.display,
                destination: destination.destination,
                finalOpen,
                ...(preparationSelection === undefined ? {} : { prepareReviewWorkspaceSelection: preparationSelection }),
                // The direct bulk destination is the reader's explicit choice.
                // It overrides a single-entry compose default and therefore
                // uses the one canonical structured Session-input delivery;
                // Attach all to New Session remains the explicit author-first
                // destination and never enters this executor.
                ...(input.action.target.kind === 'agent'
                    ? {
                        delivery: {
                            kind: 'send' as const,
                            text: promptText,
                            attachments: unit.entries.map((entry) => ({
                                entryRef: entry.entryRef,
                                display: entry.display,
                                sourceInstanceId: entry.sourceInstance.sourceInstanceId,
                                title: entry.presentation.label,
                            })),
                            idempotencyKey: unit.creationKey,
                        },
                    }
                    : {}),
                ...(resume === undefined ? {} : { resume }),
            }, startOptions);
            input.onStarted?.();
            const secondaryLinks: readonly TriageBulkLinkOutcomeV1[] =
                result.type === 'opened' || result.type === 'openPending' || result.type === 'linked'
                    ? unit.entries.slice(1).map(() => 'created' as const)
                    : result.type === 'linkPending'
                        ? unit.entries.slice(1).map(() => 'conflictedOrUnavailable' as const)
                        : [];
            let completed: TriageStartEntrySessionResultV1 = result;
            if (result.type === 'linked' && result.finalOpen === 'deferred') {
                const opened = await openLinkedSession({
                    execute: async (actionId, actionInput, options) => await input.host.executeAction(
                        actionId,
                        actionInput as unknown as JsonValue,
                        options,
                    ),
                    sessionId: result.sessionId,
                    signal: input.signal,
                });
                completed = opened.status === 'opened'
                    ? {
                        v: 1,
                        type: 'opened',
                        sessionId: result.sessionId,
                        disposition: result.disposition,
                        delivery: result.delivery,
                    }
                    : {
                        v: 1,
                        type: 'openPending',
                        sessionId: result.sessionId,
                        disposition: result.disposition,
                        delivery: result.delivery,
                    };
            }
            return {
                start: completed,
                entries: projectTriageBulkEntryOutcomesV1({
                    entries: unit.entries,
                    start: completed,
                    secondaryLinks,
                    compose: 'notRequested',
                }),
            };
        },
    });
}
