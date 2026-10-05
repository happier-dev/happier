import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { TriagePullRequestStatusResultV1Schema, type TriagePullRequestStatusResultV1 } from '@happier-dev/triage-protocol/v1';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { configuredSourceInstanceIsOwnedBy, findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageAccountCaller } from './callerSource.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import type { TriageReobserveEntryActionInputV1 } from './reobserveEntryProtocol.js';

/** Exact configured-instance routing, through the same admission and credential owners as get. */
export function createTriageReadPullRequestStatusActionHandler(): ActionHandler<
    TriageReobserveEntryActionInputV1, TriagePullRequestStatusResultV1
> {
    return async (input, context) => {
        if (!isTriageAccountCaller(context)) return { kind: 'unavailable', failure: { class: 'permission', code: 'invalidCaller' } };
        throwIfAborted(context.signal);
        const options = context.signal === undefined ? {} : { signal: context.signal };
        const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const [row, admitted] = await Promise.all([
                findConfiguredSourceInstanceRow(sourceInstances, input.sourceInstanceId, options),
                observation.readCurrent(options),
            ]);
            throwIfAborted(context.signal);
            const configured = row?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active ? row.value.configured : null;
            const source = indexTriageAdmittedSourcesV1(admitted.contributions).get(renderSourceQualifiedId(input.entryRef.source));
            const operation = source?.operations.readPullRequestStatus;
            if (configured === null || row === null || !configuredSourceInstanceIsOwnedBy(row.value, input.entryRef.source) || operation === undefined
                || source?.descriptor.kinds.find((kind) => kind.id === input.entryRef.kindId)?.workflowSubject !== 'pullRequest') {
                return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'statusUnavailable' } };
            }
            return TriagePullRequestStatusResultV1Schema.parse(await context.services.actions.executeAdmittedTargetedOperation(operation, {
                v: 1, instance: configured,
                localRef: { kindId: input.entryRef.kindId, collisionScope: input.entryRef.collisionScope, entryId: input.entryRef.entryId },
                ...(input.lastKnownLocator === undefined ? {} : { lastKnownLocator: input.lastKnownLocator }),
            }, options));
        } finally {
            observation.dispose();
        }
    };
}
