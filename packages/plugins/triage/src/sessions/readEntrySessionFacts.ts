import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRefV1, TriageEntryLocatorV1 } from '@happier-dev/triage-protocol/v1';
import { buildTriageEntryAttachmentPresentation } from '../composer/mutationPlan.js';
import { triageEntryRowKey } from '../projection/listWindow.js';
import { TriageReadEntryDetailResultV1Schema, TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import { TriageReobserveEntryResultV1Schema, TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from '../actions/reobserveEntryProtocol.js';
import { projectTriageSourceWorkflowSubjectV1, resolveTriageSourcePrepareReviewWorkspaceOperationV1, resolveTriageSourceWorkflowSubjectV1 } from '../ui/detail/sourceSurface.js';
import type { TriageAdmittedSourceV1 } from '../actions/listEntries.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import type { TriageBulkSelectedEntryV1 } from '../ui/list/bulkSelectionEntries.js';
import type { TriageBulkEntrySelectionV1 } from '../ui/list/bulkSessionPlan.js';
import type { TriageStartEntrySessionInputV1 } from '../actions/entrySessionProtocol.js';

export type TriageEntrySessionSourceFactsV1 = SurfaceContext['targetedContributions'] | Readonly<{
    kind: 'admittedSources';
    sources: ReadonlyMap<string, TriageAdmittedSourceV1>;
}>;

function sourceFacts(contributions: TriageEntrySessionSourceFactsV1, entryRef: TriageEntryRefV1) {
    if (contributions && 'kind' in contributions) {
        return { workflowSubject: projectTriageSourceWorkflowSubjectV1(
            contributions.sources.get(renderSourceQualifiedId(entryRef.source))?.descriptor, entryRef.kindId), operation: undefined };
    }
    return { workflowSubject: resolveTriageSourceWorkflowSubjectV1(contributions, entryRef),
        operation: resolveTriageSourcePrepareReviewWorkspaceOperationV1(contributions, entryRef.source) };
}

/** Reproject only facts already carried by this press; this never authorizes a fresh provider effect. */
export function readTriageRetainedEntrySessionFactsV1(
    selected: Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: string }>,
    inputs: readonly TriageStartEntrySessionInputV1[],
    contributions: TriageEntrySessionSourceFactsV1 | null,
): (TriageBulkSelectedEntryV1 & Pick<TriageBulkEntrySelectionV1, 'workflowSubject'>) | null {
    const key = triageEntryRowKey(selected.entryRef);
    const input = inputs.find((candidate) => triageEntryRowKey(candidate.entryRef) === key
        || candidate.delivery?.attachments.some((entry) => triageEntryRowKey(entry.entryRef) === key));
    if (input === undefined) return null;
    const attachment = input.delivery?.attachments.find((entry) => triageEntryRowKey(entry.entryRef) === key);
    if (attachment !== undefined && attachment.sourceInstanceId !== selected.sourceInstanceId) return null;
    const display = attachment?.display ?? input.display;
    const materialization = input.destination.kind === 'new' ? input.destination.materialization : undefined;
    const preparation = materialization?.kind === 'reviewWorkspace' ? materialization.request : undefined;
    if (preparation !== undefined && preparation.instance.instance.sourceInstanceId !== selected.sourceInstanceId) return null;
    const facts = sourceFacts(contributions ?? undefined, selected.entryRef);
    const operation = facts.operation;
    return {
        key, entryRef: selected.entryRef, display,
        sourceInstance: { source: selected.entryRef.source, sourceInstanceId: selected.sourceInstanceId },
        presentation: { label: attachment?.title ?? display.scopeLabel },
        lastKnownLocator: display.locator,
        workflowSubject: facts.workflowSubject,
        ...(operation === undefined || preparation === undefined ? {} : { reviewWorkspace: { operation, preparation } }),
    };
}

/** Exact get and durable source facts shared by bulk and configured Action callers. */
export async function readTriageEntrySessionFactsV1(
    host: Pick<PluginUiHostApi, 'executeAction'>,
    selected: Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: string; lastKnownLocator?: TriageEntryLocatorV1 }>,
    contributions: TriageEntrySessionSourceFactsV1,
    signal: AbortSignal,
): Promise<(TriageBulkSelectedEntryV1 & Pick<TriageBulkEntrySelectionV1, 'workflowSubject'>) | null> {
    const observed = TriageReobserveEntryResultV1Schema.parse(await host.executeAction(
        { pluginId: 'happier.triage', localId: TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 }, { v: 1, ...selected }, { signal },
    ));
    if (signal.aborted || observed.kind !== 'observed' || observed.observation.outcome.kind !== 'present') return null;
    const detail = TriageReadEntryDetailResultV1Schema.parse(await host.executeAction(
        { pluginId: 'happier.triage', localId: TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 },
        { v: 1, entryRef: selected.entryRef, sourceInstanceId: selected.sourceInstanceId }, { signal },
    ));
    if (signal.aborted || detail.kind !== 'read') return null;
    const observation = observed.observation;
    const present = observed.observation.outcome;
    const facts = sourceFacts(contributions, selected.entryRef);
    const operation = facts.operation;
    const reviewRevision = present.snapshot.reviewRevision;
    return {
        key: triageEntryRowKey(selected.entryRef), entryRef: selected.entryRef,
        sourceInstance: { source: selected.entryRef.source, sourceInstanceId: selected.sourceInstanceId },
        display: { locator: present.locator, scopeLabel: present.snapshot.scopeLabel },
        presentation: buildTriageEntryAttachmentPresentation({ title: present.snapshot.title, scopeLabel: present.snapshot.scopeLabel }),
        lastKnownLocator: present.locator,
        linkedSessionIds: detail.linkedSessions.map((link) => link.sessionId),
        ...(observed.investigationDefaults === undefined ? {} : { investigationDefaults: observed.investigationDefaults }),
        workflowSubject: facts.workflowSubject,
        ...(present.repository === undefined ? {} : { repository: present.repository }),
        ...(operation === undefined || reviewRevision === undefined ? {} : {
            reviewWorkspace: { operation, preparation: {
                instance: detail.instance, entryRef: selected.entryRef, lastKnownLocator: present.locator,
                observed: { ...reviewRevision, observedAtMs: observation.observedAtMs },
            } },
        }),
    };
}
