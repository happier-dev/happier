import { PluginError, type Disposable, type TargetedContributionObservation } from '@happier-dev/plugin-sdk';
import type { PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { TriagePullRequestStatusResultV1Schema, type TriagePullRequestStatusResultV1 } from '@happier-dev/triage-protocol/v1';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION } from '../corpus/collections/definitions.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { configuredSourceInstanceIsOwnedBy, findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { sameConfiguredSourceAuthority } from '../corpus/configuration/configuredSourceAuthority.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageAccountCaller } from './callerSource.js';
import { indexTriageAdmittedSourcesV1, type TriageAdmittedSourceV1 } from './listEntries.js';
import type { TriageReobserveEntryActionInputV1 } from './reobserveEntryProtocol.js';

async function resolveConfiguredStatusSource(input: TriageReobserveEntryActionInputV1, context: TriageDataActionContext,
    observation: TargetedContributionObservation<TriageAdmittedSourceV1>) {
    const options = { signal: context.signal };
    const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
    const [row, admitted] = await Promise.all([
        findConfiguredSourceInstanceRow(sourceInstances, input.sourceInstanceId, options),
        observation.readCurrent(options),
    ]);
    throwIfAborted(context.signal);
    const configured = row?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active ? row.value.configured : null;
    const source = indexTriageAdmittedSourcesV1(admitted.contributions).get(renderSourceQualifiedId(input.entryRef.source));
    const operation = source?.operations.readPullRequestStatus;
    if (configured === null || row === null || !configuredSourceInstanceIsOwnedBy(row.value, input.entryRef.source) || operation === undefined
        || source?.descriptor.kinds.find(kind => kind.id === input.entryRef.kindId)?.workflowSubject !== 'pullRequest') return null;
    return { row, sourceInstances, operation, input: { v: 1 as const, instance: configured,
        localRef: { kindId: input.entryRef.kindId, collisionScope: input.entryRef.collisionScope, entryId: input.entryRef.entryId },
        ...(input.lastKnownLocator === undefined ? {} : { lastKnownLocator: input.lastKnownLocator }),
    } };
}

/** Exact configured-instance routing, through the same admission and credential owners as get. */
export function createTriageReadPullRequestStatusActionHandler(): TriageDataActionHandler<
    TriageReobserveEntryActionInputV1, TriagePullRequestStatusResultV1
> {
    return async (input, context) => {
        if (!isTriageAccountCaller(context)) return { kind: 'unavailable', failure: { class: 'permission', code: 'invalidCaller' } };
        throwIfAborted(context.signal);
        const options = context.signal === undefined ? {} : { signal: context.signal };
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const source = await resolveConfiguredStatusSource(input, context, observation);
            if (source === null) {
                return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'statusUnavailable' } };
            }
            const result = await context.services.actions.executeAdmittedTargetedOperation(source.operation, source.input, options);
            throwIfAborted(context.signal);
            return TriagePullRequestStatusResultV1Schema.parse(result);
        } finally {
            await observation.dispose();
        }
    };
}

/** Observe exact source authority and native dependencies without running the native read. */
export function createTriageReadPullRequestStatusObserver(): PluginActionReadObserver<TriageReobserveEntryActionInputV1, TriageDataActionContext> {
    return async (input, invalidate, context) => {
        if (!isTriageAccountCaller(context)) throw new PluginError({ code: 'denied', message: 'PR status source authority is unavailable.' });
        throwIfAborted(context.signal);
        let disposed = false;
        let native: Disposable | undefined;
        let configuredRow: Disposable | undefined;
        let cleanup: Promise<void> | undefined;
        let selectedIdentity: unknown;
        const notify = () => { if (!disposed && !context.signal.aborted) invalidate(); };
        const retire = () => { if (!disposed && !context.signal.aborted) invalidate.retire(); };
        const admitted = context.services.targetedContributions.observeForSelf(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, {
            onInvalidated: () => {
                void admitted.readCurrent({ signal: context.signal }).then(snapshot => {
                    if (disposed || context.signal.aborted) return;
                    const source = indexTriageAdmittedSourcesV1(snapshot.contributions).get(renderSourceQualifiedId(input.entryRef.source));
                    const current = source?.operations.readPullRequestStatus?.identity;
                    if (!pluginJsonValuesEqual(selectedIdentity, current)) retire();
                }).catch(notify);
            },
        });
        const dispose = (): Promise<void> => {
            disposed = true;
            context.signal.removeEventListener('abort', onAbort);
            if (cleanup === undefined) {
                const handle = native;
                const rowWatch = configuredRow;
                native = undefined;
                configuredRow = undefined;
                cleanup = Promise.all([handle, rowWatch, admitted].map(async observation => { await observation?.dispose(); })).then(() => {});
            }
            return cleanup;
        };
        const onAbort = () => { void dispose().catch(() => {}); };
        context.signal.addEventListener('abort', onAbort, { once: true });
        try {
            const source = await resolveConfiguredStatusSource(input, context, admitted);
            if (source === null) throw new PluginError({ code: 'plugin_action_read_observation_unavailable', message: 'The configured PR source cannot be observed.' });
            selectedIdentity = source.operation.identity;
            const rows = requireTriageAccountStorage(context).collection(CORPUS_SOURCE_INSTANCES_COLLECTION);
            const recheck = async () => {
                const current = await rows.get(source.row.rowId, { signal: context.signal });
                if (disposed || context.signal.aborted) return;
                if (!sameConfiguredSourceAuthority(source.row.value, current === null ? null
                    : fromCorpusStoredRow<CorpusSourceInstanceRowV1>(current).value)) retire();
            };
            configuredRow = rows.watch({ kind: 'row', rowId: source.row.rowId }, () => { void recheck().catch(retire); });
            // Subscribe before the exact reread so a change after query admission cannot be lost.
            await recheck();
            throwIfAborted(context.signal);
            const attached = await context.services.actions.observeAdmittedTargetedOperation(source.operation, source.input, notify, { signal: context.signal });
            if (disposed || context.signal.aborted) await attached.dispose();
            else native = attached;
            return { dispose };
        } catch (error) {
            await dispose();
            throw error;
        }
    };
}
