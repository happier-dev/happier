import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { buildTriageEntryAttachmentPresentation } from '../composer/mutationPlan.js';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { runTriageConfiguredActionV1, type TriageConfiguredActionRunRequestV1 } from '../sessions/configuredActionRun.js';
import {
    resolveTriageSourcePrepareReviewWorkspaceOperationV1,
    resolveTriageSourceWorkflowSubjectV1,
} from '../ui/detail/sourceSurface.js';
import { TriageReadEntryDetailResultV1Schema, TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from './entryDetailProtocol.js';
import { TriageReobserveEntryResultV1Schema, TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from './reobserveEntryProtocol.js';
import {
    TriageRunConfiguredActionResultV1Schema,
    type TriageRunConfiguredActionInputV1,
    type TriageRunConfiguredActionResultV1,
} from './configuredActionRunProtocol.js';

/** Client transport of the configured-run owner, with exact source-owned entry facts. */
export function createTriageRunConfiguredActionHandler(): PluginClientActionHandler<
    TriageRunConfiguredActionInputV1, TriageRunConfiguredActionResultV1
> {
    return async (input, context) => {
        const host = context.ui;
        if (context.signal.aborted) return { v: 1, status: 'cancelled' };
        const sourceContext = await host.context({ signal: context.signal });
        if (context.signal.aborted) return { v: 1, status: 'cancelled' };
        if (sourceContext.targetedContributions === null) {
            return { v: 1, status: 'unavailable', reason: 'sourceContextUnavailable' };
        }
        const entries: Array<TriageConfiguredActionRunRequestV1['entries'][number]> = [];
        const unavailableKeys: string[] = [];
        for (const selected of input.entries) {
            if (context.signal.aborted) break;
            const key = triageEntryRowKey(selected.entryRef);
            const observed = TriageReobserveEntryResultV1Schema.parse(await host.executeAction(
                TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, { v: 1, ...selected }, { signal: context.signal },
            ));
            if (observed.kind !== 'observed' || observed.observation.outcome.kind !== 'present') {
                unavailableKeys.push(key);
                continue;
            }
            const detail = TriageReadEntryDetailResultV1Schema.parse(await host.executeAction(
                TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, { v: 1, ...selected }, { signal: context.signal },
            ));
            if (detail.kind !== 'read') { unavailableKeys.push(key); continue; }
            const observation = observed.observation;
            const present = observed.observation.outcome;
            const operation = resolveTriageSourcePrepareReviewWorkspaceOperationV1(sourceContext.targetedContributions, selected.entryRef.source);
            const reviewRevision = present.snapshot.reviewRevision;
            entries.push({
                key, entryRef: selected.entryRef,
                sourceInstance: { source: selected.entryRef.source, sourceInstanceId: selected.sourceInstanceId },
                display: { locator: present.locator, scopeLabel: present.snapshot.scopeLabel },
                presentation: buildTriageEntryAttachmentPresentation({ title: present.snapshot.title, scopeLabel: present.snapshot.scopeLabel }),
                lastKnownLocator: present.locator,
                linkedSessionIds: detail.linkedSessions.map((link) => link.sessionId),
                workflowSubject: resolveTriageSourceWorkflowSubjectV1(sourceContext.targetedContributions, selected.entryRef),
                ...(present.repository === undefined ? {} : { repository: present.repository }),
                ...(operation === undefined || reviewRevision === undefined ? {} : {
                    reviewWorkspace: { operation, preparation: {
                        instance: detail.instance, entryRef: selected.entryRef, lastKnownLocator: present.locator,
                        observed: { ...reviewRevision, observedAtMs: observation.observedAtMs },
                    } },
                }),
            });
        }
        if (context.signal.aborted) return { v: 1, status: 'cancelled' };
        if (entries.length === 0) return { v: 1, status: 'unavailable', reason: 'noEntriesAvailable', unavailableKeys };
        if (input.destination === 'single' && unavailableKeys.length > 0) {
            return { v: 1, status: 'unavailable', reason: 'singleEntryRequired', unavailableKeys };
        }
        const executionHost = {
            ...host,
            executeAction: (action: string, value: JsonValue, options?: Parameters<PluginUiHostApi['executeAction']>[2]) => host.executeAction(
                action, value, { ...options, signal: context.signal },
            ),
            selectActionInput: (request: Parameters<PluginUiHostApi['selectActionInput']>[0], options?: Parameters<PluginUiHostApi['selectActionInput']>[1]) => host.selectActionInput(
                request, { ...options, signal: context.signal },
            ),
        };
        const result = await runTriageConfiguredActionV1(executionHost, {
            actionId: input.actionId, destination: input.destination, entries, unavailableKeys,
            ...(input.reviewChoices === undefined ? {} : { reviewChoices: input.reviewChoices }),
            ...(input.resumeReview === undefined ? {} : { resumeReview: input.resumeReview }),
            ...(input.resumeStart === undefined ? {} : { resumeStart: input.resumeStart }),
            ...(input.drafts === undefined ? {} : { settlements: entries.map((entry) => {
                const draft = input.drafts?.[input.destination === 'oneSessionForAllEntries' ? 0
                    : input.entries.findIndex((selected) => triageEntryRowKey(selected.entryRef) === entry.key)];
                return draft;
            }) }),
        }, { signal: context.signal });
        return TriageRunConfiguredActionResultV1Schema.parse(result);
    };
}
