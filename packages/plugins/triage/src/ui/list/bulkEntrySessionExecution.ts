import type { JsonValue } from '@happier-dev/plugin-sdk';

import type { TriageStartEntrySessionResultV1 } from '../../actions/entrySessionProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from '../../actions/sessionLinksProtocol.js';
import { planTriageActionDeliveryV1 } from '../../sessions/actionDelivery.js';
import { openLinkedSession } from '../../sessions/entrySessionOpen.js';
import type { TriageActionV1 } from '../../settings/actions.js';
import { projectTriageNewSessionDestinationV1 } from '../header/newSessionDestination.js';
import {
    submitTriageEntrySessionStart,
    type TriageSessionStartHostV1,
} from '../header/startEntrySessionCommand.js';
import type { TriageBulkSelectedEntryV1 } from './bulkSelectionEntries.js';
import {
    projectTriageBulkEntryOutcomesV1,
    type TriageBulkComposeOutcomeV1,
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
export type TriageBulkSessionExecutionHostV1 = TriageSessionStartHostV1 & Readonly<{
    readComposer: (ref: unknown, options?: unknown) => Promise<unknown>;
    applyComposer: (ref: unknown, transaction: unknown, options?: unknown) => Promise<unknown>;
}>;

type TriageBulkStartedSessionOutcomeV1 = Readonly<{
    start: TriageStartEntrySessionResultV1;
    entries: readonly TriageBulkEntryOutcomeV1[];
}>;

/**
 * Runs already-resolved bulk Session units in order.
 *
 * Creation, primary link, delivery and generic open remain below the Triage
 * start Action. This sequence only joins those owner-owned phases with the
 * remaining links and composer work that a mounted bulk press still owns.
 */
export async function runTriageBulkEntrySessionStartsV1(input: Readonly<{
    host: TriageBulkSessionExecutionHostV1;
    units: readonly TriageBulkSessionUnitV1<TriageBulkSelectedEntryV1>[];
    action: TriageActionV1;
    /** The planned destination decides who, if anyone, performs final navigation. */
    destination: TriageBulkSessionDestinationV1;
    promptText: string | null;
    settlement: unknown;
    signal: AbortSignal;
    onStarted?: () => void;
}>): Promise<readonly TriageBulkSessionUnitResultV1<
    TriageBulkStartedSessionOutcomeV1,
    TriageBulkSelectedEntryV1
>[]> {
    // The seed destination never reaches this sequence: it is consumed by the
    // host New Session surface before a Triage Session exists.
    if (input.destination === 'attachAllToNewSession') {
        throw new Error('triage:bulk:seedDestinationCannotRun');
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
            const destination = projectTriageNewSessionDestinationV1({
                workspaceMode: input.action.workspaceMode,
                creationKey: unit.creationKey,
                settlement: input.settlement,
                ...(input.action.profileId === null ? {} : { profileId: input.action.profileId }),
            });
            if (destination.status === 'refused') throw new Error('triage:bulk:destinationRefused');
            const result = await submitTriageEntrySessionStart(input.host, {
                v: 1,
                workspaceMode: input.action.workspaceMode,
                entryRef: first.entryRef,
                display: first.display,
                destination: destination.destination,
                finalOpen,
                ...(input.action.target.kind === 'agent' && input.action.target.delivery === 'send'
                    ? {
                        delivery: {
                            kind: 'send' as const,
                            ...(input.promptText === null || input.promptText.trim().length === 0
                                ? {}
                                : { text: input.promptText }),
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
            }, { signal: input.signal });
            input.onStarted?.();
            const sessionId = result.type === 'opened' || result.type === 'openPending' || result.type === 'linked'
                ? result.sessionId
                : null;
            if (sessionId !== null) {
                const secondaryLinks = await linkRemainingEntries(
                    input.host,
                    sessionId,
                    unit.entries.slice(1),
                    input.signal,
                );
                const compose = await composeInto({
                    host: input.host,
                    action: input.action,
                    sessionId,
                    promptText: input.promptText,
                    entries: unit.entries,
                    signal: input.signal,
                });
                let completed: TriageStartEntrySessionResultV1 = result;
                if (result.type === 'linked' && result.finalOpen === 'deferred') {
                    const opened = await openLinkedSession({
                        execute: async (actionId, actionInput, options) => await input.host.executeAction(
                            actionId,
                            actionInput as unknown as JsonValue,
                            options,
                        ),
                        sessionId,
                        signal: input.signal,
                    });
                    completed = opened.status === 'opened'
                        ? {
                            v: 1,
                            type: 'opened',
                            sessionId,
                            disposition: result.disposition,
                            delivery: result.delivery,
                        }
                        : {
                            v: 1,
                            type: 'openPending',
                            sessionId,
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
                        compose,
                    }),
                };
            }
            return {
                start: result,
                entries: projectTriageBulkEntryOutcomesV1({
                    entries: unit.entries,
                    start: result,
                    secondaryLinks: [],
                    compose: 'notRequested',
                }),
            };
        },
    });
}

async function linkRemainingEntries(
    host: TriageSessionStartHostV1,
    sessionId: string,
    entries: readonly TriageBulkSelectedEntryV1[],
    signal: AbortSignal,
): Promise<readonly TriageBulkLinkOutcomeV1[]> {
    const outcomes: TriageBulkLinkOutcomeV1[] = [];
    for (const entry of entries) {
        try {
            const result = await host.executeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                v: 1,
                sessionId,
                entryRef: entry.entryRef,
                display: entry.display,
            } as never, { signal });
            outcomes.push(isRecord(result) && result.status === 'linked'
                ? 'created'
                : 'conflictedOrUnavailable');
        } catch {
            outcomes.push('conflictedOrUnavailable');
        }
    }
    return outcomes;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function composeInto(input: Readonly<{
    host: TriageBulkSessionExecutionHostV1;
    action: TriageActionV1;
    sessionId: string;
    promptText: string | null;
    entries: readonly TriageBulkSelectedEntryV1[];
    signal: AbortSignal;
}>): Promise<TriageBulkComposeOutcomeV1> {
    const target = input.action.target;
    if (target.kind !== 'agent' || target.delivery !== 'compose') return 'notRequested';
    const plan = planTriageActionDeliveryV1({
        delivery: 'compose',
        promptText: input.promptText,
        entries: input.entries.map((entry) => ({
            entryRef: entry.entryRef,
            sourceInstance: entry.sourceInstance,
            presentation: entry.presentation,
            ...(entry.lastKnownLocator === undefined
                ? {}
                : { lastKnownLocator: entry.lastKnownLocator }),
        })),
    });
    if (plan.kind !== 'compose') return 'notRequested';
    try {
        const ref = { kind: 'session', sessionId: input.sessionId };
        const read = await input.host.readComposer(ref);
        if (!isRecord(read) || read.status !== 'ready' || !isRecord(read.snapshot)) return 'refused';
        const revision = read.snapshot.revision;
        if (typeof revision !== 'number') return 'refused';
        const operations: unknown[] = [];
        if (plan.text !== undefined) operations.push({ kind: 'text.set', text: plan.text });
        for (const attachment of plan.attachments) {
            operations.push({ kind: 'attachment.add', ...attachment });
        }
        const applied = await input.host.applyComposer(ref, { expectedRevision: revision, operations });
        return isRecord(applied) && applied.status === 'applied' ? 'applied' : 'refused';
    } catch {
        return 'refused';
    }
}
