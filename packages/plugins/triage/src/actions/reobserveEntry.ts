import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import type { PluginCancellationOptions, JsonValue } from '@happier-dev/plugin-sdk';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type {
  TriageConfiguredSourceInstanceV1,
  TriageEntryLocatorV1,
  TriageEntryRefV1,
  TriageTaskFieldChoicesV1,
  TriageTaskFieldsV1,
} from '@happier-dev/triage-protocol/v1';

import {
  qualifySourceObservation,
  type CorpusQualifiedObservationV1,
  type CorpusQualificationRejectionV1,
} from '../corpus/fold/qualify.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { findConfiguredSourceInstanceRow, readConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import type { TriageAdmittedGetExecutorV1 } from '../composer/resolveForDispatch.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../definition.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { toTriageWireObservation } from '../projection/listWindowWire.js';
import {
  indexTriageAdmittedSourcesV1,
  type TriageAdmittedSourceV1,
} from './listEntries.js';
import type {
  TriageReobserveEntryActionInputV1,
  TriageReobserveEntryActionResultV1,
} from './reobserveEntryProtocol.js';

export type TriageReobserveEntryInputV1 = Readonly<{
  entryRef: TriageEntryRefV1;
  sourceInstanceId: string;
  lastKnownLocator?: TriageEntryLocatorV1;
  includeTaskFields?: true;
  includeTaskFieldChoices?: true;
}>;

export type TriageReobserveEntryResultV1 =
  | Readonly<{ kind: 'observed'; observation: CorpusQualifiedObservationV1; taskFields?: TriageTaskFieldsV1; taskFieldChoices?: TriageTaskFieldChoicesV1; detailData?: JsonValue }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'rejected'; reason: CorpusQualificationRejectionV1 }>;

export type TriageReobserveEntryDepsV1 = Readonly<{
  /** Exact active configured-instance storage read. */
  readConfiguredInstance(
    sourceInstanceId: string,
    options?: PluginCancellationOptions,
  ): Promise<TriageConfiguredSourceInstanceV1 | null>;
  readAdmittedSources(options?: PluginCancellationOptions): Promise<readonly TriageAdmittedSourceV1[]>;
  executeGet: TriageAdmittedGetExecutorV1;
  nowMs(): number;
  signal?: AbortSignal;
}>;

function sameSource(
  configured: TriageConfiguredSourceInstanceV1,
  entryRef: TriageEntryRefV1,
): boolean {
  return configured.instance.source.pluginId === entryRef.source.pluginId
    && configured.instance.source.localId === entryRef.source.localId;
}

/**
 * The target-owned exact read after a provider Action may have changed state.
 *
 * It accepts no provider Action result. The selected canonical entry and configured instance are
 * re-resolved through the target's current owners, the source's exact `get` runs once, and the
 * ordinary aggregate qualification owner rejects a mismatched or undeclared identity before the
 * observation can reach a fold.
 */
export async function reobserveTriageEntry(
  input: TriageReobserveEntryInputV1,
  deps: TriageReobserveEntryDepsV1,
): Promise<TriageReobserveEntryResultV1> {
  throwIfAborted(deps.signal);
  const invocationController = new AbortController();
  const invocationSignal = deps.signal === undefined
    ? invocationController.signal
    : AbortSignal.any([deps.signal, invocationController.signal]);
  const options: PluginCancellationOptions = {
    signal: invocationSignal,
  };
  const invocation = (async (): Promise<TriageReobserveEntryResultV1> => {
    const [configured, admitted] = await Promise.all([
      deps.readConfiguredInstance(input.sourceInstanceId, options),
      deps.readAdmittedSources(options),
    ]);
    throwIfAborted(invocationSignal);
    if (configured === null || !sameSource(configured, input.entryRef)) {
      return { kind: 'unavailable' };
    }

    const contribution = indexTriageAdmittedSourcesV1(admitted)
      .get(renderSourceQualifiedId(input.entryRef.source));
    if (contribution === undefined) return { kind: 'unavailable' };

    const observed = await deps.executeGet(contribution.operations.get, {
      v: 1,
      instance: configured,
      localRef: {
        kindId: input.entryRef.kindId,
        collisionScope: input.entryRef.collisionScope,
        entryId: input.entryRef.entryId,
      },
      ...(input.lastKnownLocator === undefined
        ? {}
        : { lastKnownLocator: input.lastKnownLocator }),
      ...(input.includeTaskFieldChoices === true ? { includeTaskFieldChoices: true as const } : {}),
    }, options);
    const qualified = qualifySourceObservation({
      source: input.entryRef.source,
      declaredKindIds: contribution.descriptor.kinds.map((kind) => kind.id),
      sourceInstanceId: input.sourceInstanceId,
      observedAtMs: deps.nowMs(),
      observation: observed,
      requestedEntryRef: input.entryRef,
    });
    return qualified.status === 'qualified'
      ? { kind: 'observed', observation: qualified.observation,
          ...(input.includeTaskFields === true && observed.kind === 'present' && observed.taskFields !== undefined
            ? { taskFields: observed.taskFields } : {}),
          ...(input.includeTaskFieldChoices === true && observed.kind === 'present' && observed.taskFieldChoices !== undefined
            ? { taskFieldChoices: observed.taskFieldChoices } : {}),
          ...(observed.kind === 'present' && observed.detailData !== undefined ? { detailData: observed.detailData } : {}) }
      : { kind: 'rejected', reason: qualified.reason };
  })();
  try {
    return await invocation;
  } finally {
    invocationController.abort();
  }
}

export function createTriageReobserveEntryActionHandler(): TriageDataActionHandler<
  TriageReobserveEntryActionInputV1,
  TriageReobserveEntryActionResultV1
> {
  return async (input, context: TriageDataActionContext) => {
    const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
    const result = await reobserveTriageEntry(input, {
      readConfiguredInstance: async (sourceInstanceId, options) => {
        const row = input.sourceInstanceRowId === undefined
          ? await findConfiguredSourceInstanceRow(sourceInstances, sourceInstanceId, options)
          : await readConfiguredSourceInstanceRow(sourceInstances, input.sourceInstanceRowId, options);
        return row?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
          && (input.sourceInstanceRowId === undefined || row.value.configured.instance.sourceInstanceId === sourceInstanceId)
          ? row.value.configured
          : null;
      },
      readAdmittedSources: async (options) => {
        const observation = context.services.targetedContributions.observeForSelf(
          TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
          { onInvalidated: () => {} },
        );
        try {
          return (await observation.readCurrent(options)).contributions;
        } finally {
          observation.dispose();
        }
      },
      executeGet: async (operation, getInput, options) => await context.services.actions
        .executeAdmittedTargetedOperation(operation, getInput, options ?? {}),
      nowMs: () => Date.now(),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.kind === 'observed') {
      const { entryRef, ...observation } = result.observation;
      return { kind: 'observed', entryRef, observation: toTriageWireObservation(observation),
        ...(result.taskFields === undefined ? {} : { taskFields: result.taskFields }),
        ...(result.taskFieldChoices === undefined ? {} : { taskFieldChoices: result.taskFieldChoices }),
        ...(result.detailData === undefined ? {} : { detailData: result.detailData }) };
    }
    return result.kind === 'unavailable'
      ? { kind: 'unavailable' }
      : { kind: 'rejected' };
  };
}
