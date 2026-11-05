import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';

import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageTaskWriteResultV1Schema, type TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { configuredSourceInstanceIsOwnedBy, findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { qualifySourceObservation } from '../corpus/fold/qualify.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageHostActionCaller } from './callerSource.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import type {
    TriageCreateTaskActionInputV1,
    TriageEditTaskActionInputV1,
    TriageTransitionTaskActionInputV1,
} from './tasksProtocol.js';

type TaskWriteRequest =
    | Readonly<{ role: 'create'; input: TriageCreateTaskActionInputV1 }>
    | Readonly<{ role: 'edit'; input: TriageEditTaskActionInputV1 }>
    | Readonly<{ role: 'transition'; input: TriageTransitionTaskActionInputV1 }>;

/** Thin transport: the configured-instance and admitted source owners grant authority;
 * the source's named Action owns authorization, provider writes and settlement. */
async function writeTask(request: TaskWriteRequest, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
    if (!isTriageHostActionCaller(context)
        && (context.caller?.kind !== 'plugin' || context.caller.pluginId !== TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1)) {
        return { kind: 'failed', failure: { class: 'permission', code: 'invalidCaller' } };
    }
    throwIfAborted(context.signal);
    const options = context.signal === undefined ? {} : { signal: context.signal };
    const address = request.role === 'create'
        ? { source: request.input.source, kindId: request.input.kindId }
        : request.input.entryRef;
    const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
    );
    try {
        const [row, admitted] = await Promise.all([
            findConfiguredSourceInstanceRow(sourceInstances, request.input.sourceInstanceId, options),
            observation.readCurrent(options),
        ]);
        throwIfAborted(context.signal);
        const configured = row?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active ? row.value.configured : null;
        const source = indexTriageAdmittedSourcesV1(admitted.contributions).get(renderSourceQualifiedId(address.source));
        if (configured === null || row === null || !configuredSourceInstanceIsOwnedBy(row.value, address.source) || source === undefined) {
            return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'taskSourceUnavailable' } };
        }
        const kind = source.descriptor.kinds.find((candidate) => candidate.id === address.kindId);
        if (kind?.task !== true) return { kind: 'refused', reason: 'unsupportedKind' };
        if (request.role !== 'transition') {
            const fields = request.role === 'create' ? kind.taskCapabilities?.createFields : kind.taskCapabilities?.editFields;
            if (Object.keys(request.input.fields).some((field) => !fields?.some((supported) => supported === field))) {
                return { kind: 'refused', reason: 'unsupportedField' };
            }
        }

        const acceptResult = (value: unknown): TriageTaskWriteResultV1 => {
            const result = TriageTaskWriteResultV1Schema.parse(value);
            if ('observation' in result && result.observation !== undefined) {
                const qualified = qualifySourceObservation({
                    source: address.source,
                    declaredKindIds: [address.kindId],
                    sourceInstanceId: request.input.sourceInstanceId,
                    observedAtMs: context.invokedAtMs,
                    observation: result.observation,
                    ...(request.role === 'create' ? {} : { requestedEntryRef: request.input.entryRef }),
                });
                if (qualified.status === 'rejected') {
                    // The write already ran. An unrelated observation proves
                    // neither success nor no effect, so never replay it.
                    return { kind: 'uncertain', failure: { class: 'unsupportedContract', code: 'taskObservationMismatch' } };
                }
            }
            return result;
        };

        // These are exact declared roles, not a provider verb/payload envelope.
        // Original host-issued handles pass through unchanged. There is one call,
        // no replay and no aggregate confirming read after an uncertain write.
        if (request.role === 'create') {
            const operation = source.operations.create;
            if (operation === undefined) return { kind: 'refused', reason: 'unsupportedOperation' };
            return acceptResult(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                v: 1, instance: configured, kindId: request.input.kindId, fields: request.input.fields,
            }, options));
        }
        const entry = request.input.entryRef;
        const addressed = {
            v: 1 as const, instance: configured,
            localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId },
            ...(request.input.lastKnownLocator === undefined ? {} : { lastKnownLocator: request.input.lastKnownLocator }),
        };
        if (request.role === 'edit') {
            const operation = source.operations.edit;
            if (operation === undefined) return { kind: 'refused', reason: 'unsupportedOperation' };
            return acceptResult(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                ...addressed, fields: request.input.fields,
            }, options));
        }
        const operation = source.operations.transition;
        if (operation === undefined) return { kind: 'refused', reason: 'unsupportedOperation' };
        return acceptResult(await context.services.actions.executeAdmittedTargetedOperation(operation, {
            ...addressed, transitionId: request.input.transitionId,
        }, options));
    } finally {
        observation.dispose();
    }
}

export function createTriageCreateTaskActionHandler(): TriageDataActionHandler<TriageCreateTaskActionInputV1, TriageTaskWriteResultV1> {
    return async (input, context) => await writeTask({ role: 'create', input }, context);
}
export function createTriageEditTaskActionHandler(): TriageDataActionHandler<TriageEditTaskActionInputV1, TriageTaskWriteResultV1> {
    return async (input, context) => await writeTask({ role: 'edit', input }, context);
}
export function createTriageTransitionTaskActionHandler(): TriageDataActionHandler<TriageTransitionTaskActionInputV1, TriageTaskWriteResultV1> {
    return async (input, context) => await writeTask({ role: 'transition', input }, context);
}
