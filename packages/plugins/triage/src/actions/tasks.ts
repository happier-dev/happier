import { readAccountDataSourceRecordsV1 } from '../corpus/configuration/accountDataSources.js';
import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';

import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageTaskWriteResultV1Schema, type TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { configuredSourceInstanceIsOwnedBy, findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { qualifySourceObservation } from '../corpus/fold/qualify.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageHostActionCaller } from './callerSource.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import type {
    TriageCreateTaskActionInputV1,
    TriageCreateTaskActionResultV1,
    TriageEditTaskActionInputV1,
    TriageTransitionTaskActionInputV1,
} from './tasksProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, TriageLinkEntryToSessionActionResultV1Schema } from './sessionLinksProtocol.js';
import { TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageSetTaskOriginErrorResultV1Schema } from './taskOriginProtocol.js';
import { triageTaskWriteInvocationFailureV1 } from './taskWriteFailure.js';

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
    const readSetup = async () => {
        const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const admitted = await observation.readCurrent(options);
            const row = await findConfiguredSourceInstanceRow(sourceInstances, request.input.sourceInstanceId, {
                ...options, accountDataSources: readAccountDataSourceRecordsV1(admitted.contributions),
            });
            throwIfAborted(context.signal);
            return { row, admitted, observation };
        } catch (error) {
            observation.dispose();
            throw error;
        }
    };
    let setup: Awaited<ReturnType<typeof readSetup>>;
    try { setup = await readSetup(); }
    catch (error) {
        // No source write has been dispatched; this failure cannot mean that it may have created or changed a task.
        return { kind: 'failed', failure: { class: 'unknown', code: isPluginError(error) ? error.code : 'taskSourceUnavailable' } };
    }
    try {
        const { row, admitted } = setup;
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
        const invokeWrite = async (operation: () => Promise<unknown>): Promise<TriageTaskWriteResultV1> => {
            try { return acceptResult(await operation()); }
            catch (error) {
                // The source needs the pressing person's review before any write; the
                // host carries this press's review back to their UI and re-presses.
                if (isPluginError(error) && error.code === 'action_interactive_review_required') throw error;
                return triageTaskWriteInvocationFailureV1(error);
            }
        };

        // These are exact declared roles, not a provider verb/payload envelope.
        // Original host-issued handles pass through unchanged. There is one call,
        // no replay and no aggregate confirming read after an uncertain write.
        if (request.role === 'create') {
            const operation = source.operations.create;
            if (operation === undefined) return { kind: 'refused', reason: 'unsupportedOperation' };
            if (request.input.initialStatusId !== undefined && kind.taskCapabilities?.initialStatuses === undefined) {
                return { kind: 'refused', reason: 'unsupportedField' };
            }
            return await invokeWrite(() => context.services.actions.executeAdmittedTargetedOperation(operation, {
                v: 1, instance: configured, kindId: request.input.kindId, fields: request.input.fields,
                ...(request.input.placeId === undefined ? {} : { placeId: request.input.placeId }),
                ...(request.input.initialStatusId === undefined ? {} : { initialStatusId: request.input.initialStatusId }),
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
            return await invokeWrite(() => context.services.actions.executeAdmittedTargetedOperation(operation, {
                ...addressed, fields: request.input.fields,
            }, options));
        }
        const operation = source.operations.transition;
        if (operation === undefined) return { kind: 'refused', reason: 'unsupportedOperation' };
        return await invokeWrite(() => context.services.actions.executeAdmittedTargetedOperation(operation, {
            ...addressed, transitionId: request.input.transitionId,
            ...(request.input.fieldValues === undefined ? {} : { fieldValues: request.input.fieldValues }),
        }, options));
    } finally {
        setup.observation.dispose();
    }
}

export function createTriageCreateTaskActionHandler(): TriageDataActionHandler<TriageCreateTaskActionInputV1, TriageCreateTaskActionResultV1> {
    return async (input, context) => {
        const creation = await writeTask({ role: 'create', input }, context);
        // A response-loss create is never replayed, and its uncertain observation cannot authorize a link.
        if (creation.kind !== 'applied' || input.linkSession === undefined && input.originError === undefined) return creation;
        const entryRef = { source: input.source, ...creation.observation.localRef };
        const attemptLink = async (link: () => Promise<'linked' | 'failed' | 'unknown'>) => {
            if (context.signal.aborted) return 'failed' as const;
            try {
                return await link();
            } catch (error) {
                return triageTaskWriteInvocationFailureV1(error).kind === 'refused' ? 'failed' as const : 'unknown' as const;
            }
        };
        const linkSession = input.linkSession;
        const sessionLink = linkSession === undefined ? undefined : await attemptLink(async () => {
            const result = TriageLinkEntryToSessionActionResultV1Schema.parse(await context.services.actions.execute({
                pluginId: context.plugin.id, localId: TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
            }, {
                v: 1, sessionId: linkSession, sourceInstanceId: input.sourceInstanceId, entryRef,
                display: { locator: creation.observation.locator, scopeLabel: creation.observation.snapshot.scopeLabel },
            }, { signal: context.signal }));
            return result.status;
        });
        const originError = input.originError;
        const originErrorLink = originError === undefined ? undefined : await attemptLink(async () => {
            const result = TriageSetTaskOriginErrorResultV1Schema.parse(await context.services.actions.execute({
                pluginId: context.plugin.id, localId: TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1,
            }, {
                v: 1, entryRef, originError,
                displayAtMark: { title: creation.observation.snapshot.title, scopeLabel: creation.observation.snapshot.scopeLabel },
            }, { signal: context.signal }));
            return result.status === 'linked' ? 'linked' : 'failed';
        });
        return { kind: 'createdAndLinkAttempted', creation,
            ...(sessionLink === undefined ? {} : { sessionLink }),
            ...(originErrorLink === undefined ? {} : { originErrorLink }),
        };
    };
}
export function createTriageEditTaskActionHandler(): TriageDataActionHandler<TriageEditTaskActionInputV1, TriageTaskWriteResultV1> {
    return async (input, context) => await writeTask({ role: 'edit', input }, context);
}
export function createTriageTransitionTaskActionHandler(): TriageDataActionHandler<TriageTransitionTaskActionInputV1, TriageTaskWriteResultV1> {
    return async (input, context) => await writeTask({ role: 'transition', input }, context);
}
