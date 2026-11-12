import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi, PluginUiActionReference, PluginUiActionInputFor, PluginUiActionExecutionOptions } from '@happier-dev/plugin-sdk/ui';
import type { TriageSessionHandoffResultV1 } from '@happier-dev/triage-protocol/v1';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { runTriageConfiguredActionV1, runTriageConfiguredHandoffV1, type TriageConfiguredActionRunRequestV1 } from '../sessions/configuredActionRun.js';
import { readTriageEntrySessionFactsV1, readTriageRetainedEntrySessionFactsV1,
    type TriageEntrySessionSourceFactsV1 } from '../sessions/readEntrySessionFacts.js';
import { createTriageConfiguredActionHost } from './configuredActionHost.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import {
    TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1,
    TriageRunConfiguredActionResultV1Schema,
    TriageRunConfiguredActionInputV1Schema,
    type TriageLegacyRunConfiguredActionResultV1,
    type TriageLegacyConfiguredStartRecoveryV1,
    type TriageRunConfiguredActionResultV1,
} from './configuredActionRunProtocol.js';

async function readConfiguredSourceContext(context: PluginAccountActionContext): Promise<Readonly<{
    targetedContributions: TriageEntrySessionSourceFactsV1 | null;
}>> {
    if (context.ui) return await context.ui.context({ signal: context.signal });
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated() {} },
    );
    try {
        const snapshot = await observation.readCurrent({ signal: context.signal });
        return { targetedContributions: { kind: 'admittedSources', sources: indexTriageAdmittedSourcesV1(snapshot.contributions) } };
    } finally { observation.dispose(); }
}

/** Portable transport of the configured owner, with optional ordinary UI authoring. */
export function createTriageRunConfiguredActionHandler(): PluginAccountActionHandler<
    JsonValue, TriageRunConfiguredActionResultV1
> {
    return async (value, context) => {
        const input = TriageRunConfiguredActionInputV1Schema.parse(value);
        const host = createTriageConfiguredActionHost(context);
        if (input.handoff.context.kind !== 'entries') {
            const finish = (handoff: TriageSessionHandoffResultV1) => ({ v: 1 as const, handoff,
                ...(input.resumeStart === undefined ? {} : { recovery: input.resumeStart }) });
            if (context.signal.aborted) return finish({ kind: 'cancelled' });
            if (input.drafts !== undefined || input.reviewChoices !== undefined || input.resumeReview !== undefined || input.singleIntent !== undefined) {
                return finish({ kind: 'unavailable', reason: 'scopeMismatch' });
            }
            const selected = [
                ...(input.handoff.context.kind === 'entry' ? [input.handoff.context.entry] : []),
                ...input.handoff.evidence.flatMap((evidence) => evidence.kind === 'entry' || evidence.kind === 'alertEntry' ? [evidence.entry] : []),
            ].filter((entry, index, all) => all.findIndex((candidate) => triageEntryRowKey(candidate.entryRef) === triageEntryRowKey(entry.entryRef)
                && candidate.sourceInstanceId === entry.sourceInstanceId) === index);
            const entries: Array<TriageConfiguredActionRunRequestV1['entries'][number]> = [];
            if (selected.length > 0) {
                try {
                    const sourceContext = await readConfiguredSourceContext(context);
                    if (context.signal.aborted) return finish({ kind: 'cancelled' });
                    if (sourceContext.targetedContributions === null) return finish({ kind: 'unavailable', reason: 'evidenceInvalid' });
                    for (const entry of selected) {
                        const facts = await readTriageEntrySessionFactsV1(host, entry, sourceContext.targetedContributions, context.signal);
                        if (context.signal.aborted) return finish({ kind: 'cancelled' });
                        if (facts === null) return finish({ kind: 'unavailable', reason: 'evidenceInvalid' });
                        entries.push(facts);
                    }
                } catch (error) {
                    if (context.signal.aborted) return finish({ kind: 'cancelled' });
                    throw error;
                }
            }
            // Only the canonical Action front door supplies these exact targets.
            const resolved = context.sessionTargetsV1;
            return TriageRunConfiguredActionResultV1Schema.parse(await runTriageConfiguredHandoffV1(host, input.handoff, {
                entries, signal: context.signal, ...(resolved?.targets.length === 1 ? { session: resolved.targets[0] } : {}),
                ...(input.resumeStart === undefined ? {} : { resumeStart: input.resumeStart }),
            }));
        }
        const selectedEntries = input.handoff.context.entries;
        const destination = input.handoff.context.destination;
        const finish = (result: TriageLegacyRunConfiguredActionResultV1): TriageRunConfiguredActionResultV1 =>
            TriageRunConfiguredActionResultV1Schema.parse({ ...result,
                handoff: { kind: 'entryExecution', status: result.status },
                ...(result.recovery === undefined ? {} : { recovery: { ...result.recovery, handoff: input.handoff } }),
            });
        if (context.signal.aborted) return finish({ v: 1, status: 'cancelled' });
        if (input.singleIntent !== undefined && destination !== 'single'
            || input.handoff.sessionChoice.kind !== 'configured' || input.handoff.agentChoice.kind !== 'configured'
            || input.handoff.delivery !== 'configured' || input.handoff.evidence.some(evidence =>
                (evidence.kind !== 'entry' && evidence.kind !== 'alertEntry') || !selectedEntries.some(entry =>
                    triageEntryRowKey(entry.entryRef) === triageEntryRowKey(evidence.entry.entryRef)
                    && entry.sourceInstanceId === evidence.entry.sourceInstanceId))) {
            return finish({ v: 1, status: 'unavailable', reason: 'scopeMismatch' });
        }
        if (input.resumeStart?.state.kind === 'handoff'
            || input.resumeStart !== undefined && 'handoff' in input.resumeStart && input.resumeStart.handoff !== undefined
                && JSON.stringify(input.resumeStart.handoff) !== JSON.stringify(input.handoff)) {
            return finish({ v: 1, status: 'unavailable', reason: 'startContinuationMismatch' });
        }
        // The nested state discriminator above excludes non-entry custody.
        const resumeStart = input.resumeStart as TriageLegacyConfiguredStartRecoveryV1 | undefined;
        const continuing = input.resumeStart !== undefined || input.resumeReview !== undefined;
        const sourceContext = await readConfiguredSourceContext(context).catch((error: unknown) => {
            if (!continuing) throw error;
            return { targetedContributions: null };
        });
        if (context.signal.aborted) return finish({ v: 1, status: 'cancelled' });
        if (!continuing && sourceContext.targetedContributions === null) {
            return finish({ v: 1, status: 'unavailable', reason: 'sourceContextUnavailable' });
        }
        const entries: Array<TriageConfiguredActionRunRequestV1['entries'][number]> = [];
        const unavailableKeys: string[] = [];
        const retainedInputs = resumeStart?.state.kind === 'single' ? [resumeStart.state.input]
            : resumeStart?.state.kind === 'bulk' ? resumeStart.state.units.map((unit) => unit.input) : [];
        for (const selected of selectedEntries) {
            if (context.signal.aborted) break;
            const key = triageEntryRowKey(selected.entryRef);
            const facts = continuing
                ? readTriageRetainedEntrySessionFactsV1(selected, retainedInputs, sourceContext.targetedContributions)
                : await readTriageEntrySessionFactsV1(host, selected, sourceContext.targetedContributions ?? undefined, context.signal);
            if (facts === null) { unavailableKeys.push(key); continue; }
            entries.push(facts);
        }
        if (context.signal.aborted) return finish({ v: 1, status: 'cancelled' });
        if (!continuing && entries.length === 0) return finish({ v: 1, status: 'unavailable', reason: 'noEntriesAvailable', unavailableKeys });
        if (!continuing && destination === 'single' && unavailableKeys.length > 0) {
            return finish({ v: 1, status: 'unavailable', reason: 'singleEntryRequired', unavailableKeys });
        }
        const executionHost = {
            ...host,
            executeAction: <TAction extends PluginUiActionReference>(action: TAction, value?: PluginUiActionInputFor<TAction>, options?: PluginUiActionExecutionOptions) => host.executeAction<TAction>(
                action, value, { ...options, signal: context.signal },
            ),
            selectActionInput: (request: Parameters<PluginUiHostApi['selectActionInput']>[0], options?: Parameters<PluginUiHostApi['selectActionInput']>[1]) => host.selectActionInput(
                request, { ...options, signal: context.signal },
            ),
        };
        const result = await runTriageConfiguredActionV1(executionHost, {
            actionId: input.handoff.configuredActionId, destination, entries, unavailableKeys,
            ...(input.singleIntent === undefined ? {} : { singleIntent: input.singleIntent }),
            ...(continuing ? { selectedEntries } : {}),
            ...(input.reviewChoices === undefined ? {} : { reviewChoices: input.reviewChoices }),
            ...(input.resumeReview === undefined ? {} : { resumeReview: input.resumeReview }),
            ...(resumeStart === undefined ? {} : { resumeStart }),
            ...(input.drafts === undefined ? {} : { settlements: entries.map((entry) => {
                const draft = input.drafts?.[destination === 'oneSessionForAllEntries' ? 0
                    : selectedEntries.findIndex((selected) => triageEntryRowKey(selected.entryRef) === entry.key)];
                return draft;
            }) }),
        }, { signal: context.signal });
        return finish(result);
    };
}

export function activate(api: PluginAccountApi): void {
    api.actions.register(TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, createTriageRunConfiguredActionHandler());
}
